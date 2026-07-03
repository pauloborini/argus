import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { initWorkspace, getWorkspacePath } from "../workspace/workspace.js";
import { runIndex } from "./index-cmd.js";
import { runAgentRulesInstall, runAgentRulesUninstall } from "./agent-rules.js";
import { runHookInstall, runHookUninstall } from "./hooks.js";
import {
  registerMcpForHosts,
  unregisterMcpForHosts,
  resolveDefaultHosts,
  SUPPORTED_HOSTS,
  type McpHostId,
  type McpScope,
} from "../install/mcp-hosts.js";
import {
  listWorkspaceRoots,
  registerWorkspace,
  unregisterWorkspace,
} from "../daemon/registry.js";
import { installService, uninstallService } from "../daemon/service.js";
import { isDaemonRunning, runDaemonReload, runDaemonStart } from "./daemon.js";
import { migrateLegacyAthena } from "../memory/migrate-legacy-athena.js";
import { VaultEngine } from "../memory/vault-engine.js";

/** Aguarda o daemon publicar o pidfile após um start destacado (best-effort). */
async function waitForDaemon(timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDaemonRunning()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export interface InstallOptions {
  hosts?: McpHostId[];
  /** Escopo de registro do MCP (global = todos os projetos; local = repo). */
  scope?: McpScope;
  /** Pula o serviço/daemon (apenas fia índice + MCP). */
  noDaemon?: boolean;
  /** Pula o registro de MCP nos hosts. */
  noMcp?: boolean;
  /** Instala hooks git como fallback (default: não — o daemon cobre). */
  withHooks?: boolean;
  /** Pula init/sync do cofre de memória. */
  noMemory?: boolean;
}

/**
 * Fiação zero-toque de um repo: workspace + índice + agent-rules + registro de
 * MCP nos hosts + registro no daemon (com serviço auto-start). Um comando,
 * idempotente. Hooks git só com `--with-hooks` (fallback de daemon down).
 */
export async function runInstall(options: InstallOptions = {}): Promise<number> {
  const cwd = process.cwd();
  const root = resolve(cwd);
  const summary: string[] = [];
  let hadPartialFailure = false;

  // 1. Workspace
  const init = initWorkspace(cwd);
  if (!init.ok) {
    console.error(init.message);
    return 1;
  }
  summary.push(init.created ? "workspace criado" : "workspace já existia");

  // 2. Índice inicial
  const indexCode = await runIndex();
  if (indexCode !== 0) {
    console.error("Falha ao construir índice inicial.");
    return indexCode;
  }
  summary.push("índice construído");

  if (!options.noMemory) {
    const migration = migrateLegacyAthena(cwd);
    if (migration.status === "failed") {
      console.error(migration.message);
      return 1;
    }
    if (migration.status === "migrated") {
      summary.push("legado .athena migrado para .argus/memory");
    }

    const initMemory = VaultEngine.init(cwd);
    if (initMemory.state === "falha") {
      console.error(initMemory.message);
      return 1;
    }
    const syncMemory = VaultEngine.sync(cwd);
    if (syncMemory.state === "falha") {
      console.error(syncMemory.message);
      return 1;
    }
    summary.push("cofre de memória inicializado");
  }

  // 3. Agent-rules (alavanca portável para o agente usar o Argus)
  runAgentRulesInstall(cwd);
  summary.push("agent-rules escritas (CLAUDE.md/AGENTS.md)");

  // 4. Registro de MCP nos hosts. Sem `--hosts`, auto-detecta os instalados
  // (claude-code/cursor sempre; codex/opencode/pi só quando presentes).
  if (!options.noMcp) {
    const hosts = options.hosts ?? resolveDefaultHosts(root, options.scope);
    const results = registerMcpForHosts(root, hosts, options.scope);
    for (const r of results) {
      console.log(`  MCP ${r.message}`);
    }
    const failed = results.filter((r) => !r.ok).map((r) => r.host);
    if (failed.length > 0) {
      hadPartialFailure = true;
      summary.push(`MCP com falha (${failed.join(", ")}) — veja mensagens acima`);
    } else {
      summary.push(`MCP registrado (${hosts.join(", ")})`);
    }
  }

  // 5. Registro no daemon (antes de subir o serviço, para o boot já ver o repo)
  if (!options.noDaemon) {
    registerWorkspace(root);
    summary.push("repo registrado no daemon");

    // 6. Serviço de usuário (auto-start no login + restart)
    const service = installService();
    console.log(`  ${service.message}`);

    // 7. Garante daemon vivo e ciente do novo workspace — confirmando de fato.
    if (isDaemonRunning()) {
      runDaemonReload();
      summary.push("daemon ativo (registry recarregado)");
    } else {
      const startCode = await runDaemonStart();
      if (startCode === 0 && (await waitForDaemon())) {
        summary.push("daemon ativo");
      } else {
        hadPartialFailure = true;
        summary.push(
          "daemon NÃO subiu — verifique 'argus daemon status' e rode 'argus daemon start'",
        );
      }
    }

    // Degrada honesto: serviço de auto-start pode falhar (permissão/plataforma)
    // sem derrubar o resto da fiação.
    if (!service.ok) {
      hadPartialFailure = true;
      summary.push(
        "auto-start no login NÃO instalado (o daemon não reinicia sozinho) — veja a mensagem acima",
      );
    }
  }

  // 8. Hooks git (opcional, fallback)
  if (options.withHooks) {
    runHookInstall(cwd);
    summary.push("hooks git instalados (fallback)");
  }

  console.log("\n✓ Argus instalado neste repositório:");
  for (const item of summary) {
    console.log(`  • ${item}`);
  }
  if (hadPartialFailure) {
    console.log("\nInstalação concluída com pendências — corrija os itens acima.");
    return 1;
  }
  console.log("\nA partir daqui é só codar — o índice se mantém fresco sozinho.");
  return 0;
}

export interface UninstallOptions {
  hosts?: McpHostId[];
  /** Escopo de registro a limpar (global = todos os projetos; local = repo). */
  scope?: McpScope;
  /** Remove também o diretório `.argus/` (índice local). */
  purge?: boolean;
}

/** Reverte a fiação de um repo, sem deixar resíduo. */
export function runUninstall(options: UninstallOptions = {}): number {
  const cwd = process.cwd();
  const root = resolve(cwd);
  // Sem `--hosts`, tenta todos os suportados (no-op quando não registrado), pra
  // não deixar resíduo em nenhum host.
  const hosts = options.hosts ?? SUPPORTED_HOSTS;

  unregisterWorkspace(root);
  for (const r of unregisterMcpForHosts(root, hosts, options.scope)) {
    console.log(`  MCP ${r.message}`);
  }
  runAgentRulesUninstall(cwd);
  runHookUninstall(cwd);

  // Se nenhum workspace resta, remove o serviço global do daemon.
  if (listWorkspaceRoots().length === 0) {
    const service = uninstallService();
    console.log(`  ${service.message}`);
  } else if (isDaemonRunning()) {
    runDaemonReload();
  }

  if (options.purge) {
    rmSync(getWorkspacePath(cwd), { recursive: true, force: true });
    console.log("  .argus/ removido (--purge)");
  }

  console.log("\n✓ Argus desinstalado deste repositório.");
  return 0;
}
