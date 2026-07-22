import { rmSync } from "node:fs";
import { initWorkspace, getWorkspacePath } from "../workspace/workspace.js";
import { requireWorkspaceRoot, findShadowArgusState } from "../workspace/resolve-workspace.js";
import { runIndex } from "./index-cmd.js";
import {
  installAgentRules,
  runAgentRulesInstall,
  runAgentRulesUninstall,
  type AgentRulesInstallSummary,
} from "./agent-rules.js";
import { runHookInstall, runHookUninstall } from "./hooks.js";
import {
  registerMcpForHosts,
  unregisterMcpForHosts,
  resolveDefaultHosts,
  SUPPORTED_HOSTS,
  type HostRegistrationResult,
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

/** Opt-out de refresh automático de regras/MCP (D3). */
export const ARGUS_NO_INSTALL_REFRESH_ENV = "ARGUS_NO_INSTALL_REFRESH";

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function isInstallRefreshOptedOut(
  envValue: string | undefined = process.env[ARGUS_NO_INSTALL_REFRESH_ENV],
): boolean {
  return isTruthyEnv(envValue);
}

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

export interface InstallRefreshOptions {
  hosts?: McpHostId[];
  scope?: McpScope;
  /** Pula o refresh de entradas MCP. */
  noMcp?: boolean;
}

export interface InstallRefreshSummary {
  skipped: boolean;
  optOut: boolean;
  manualHint?: string;
  rules?: AgentRulesInstallSummary;
  mcp?: HostRegistrationResult[];
  restartHint?: string;
  messages: string[];
}

function replaceHealedRegistryRoot(
  handle: ReturnType<typeof requireWorkspaceRoot>,
  ensureCanonical: boolean,
): void {
  const previous = handle.previousRootPath;
  const removedPrevious = previous ? unregisterWorkspace(previous) : false;
  if (ensureCanonical || removedPrevious) {
    registerWorkspace(handle.rootPath);
  }
}

function formatShadowDiagnostic(handle: ReturnType<typeof requireWorkspaceRoot>): string[] {
  const shadow = findShadowArgusState(handle);
  if (shadow.shadows.length === 0) {
    return [];
  }
  return [
    `Estado canônico: ${shadow.canonical}`,
    `Estado(s) sombra: ${shadow.shadows.join(", ")} (não removido — D5)`,
  ];
}

/**
 * Fiação zero-toque de um repo: workspace + índice + agent-rules + registro de
 * MCP nos hosts + registro no daemon (com serviço auto-start). Um comando,
 * idempotente. Hooks git só com `--with-hooks` (fallback de daemon down).
 */
export async function runInstall(options: InstallOptions = {}): Promise<number> {
  const cwd = process.cwd();
  const summary: string[] = [];
  let hadPartialFailure = false;

  // 1. Workspace
  const init = initWorkspace(cwd);
  if (!init.ok) {
    console.error(init.message);
    return 1;
  }
  summary.push(init.created ? "workspace criado" : "workspace já existia");

  // Resolve+heal para obter o root canônico (D4). Todo I/O subsequente usa root.
  const handle = requireWorkspaceRoot(cwd);
  const root = handle.rootPath;

  // 2. Índice inicial
  const indexCode = await runIndex();
  if (indexCode !== 0) {
    console.error("Falha ao construir índice inicial.");
    return indexCode;
  }
  summary.push("índice construído");

  if (!options.noMemory) {
    const migration = migrateLegacyAthena(root);
    if (migration.status === "failed") {
      console.error(migration.message);
      return 1;
    }
    if (migration.status === "migrated") {
      summary.push("legado .athena migrado para .argus/memory");
    }

    const initMemory = VaultEngine.init(root);
    if (initMemory.state === "falha") {
      console.error(initMemory.message);
      return 1;
    }
    const syncMemory = VaultEngine.sync(root);
    if (syncMemory.state === "falha") {
      console.error(syncMemory.message);
      return 1;
    }
    summary.push("cofre de memória inicializado");
  }

  // 3. Agent-rules (alavanca portável para o agente usar o Argus)
  runAgentRulesInstall(root);
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
    replaceHealedRegistryRoot(handle, true);
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
    runHookInstall(root);
    summary.push("hooks git instalados (fallback)");
  }

  // 9. Diagnóstico de sombra (D5): reporta sem apagar
  const shadowMessages = formatShadowDiagnostic(handle);
  if (shadowMessages.length > 0) {
    console.log("\n⚠ .argus sombra detectado (não removido automaticamente — D5):");
    for (const message of shadowMessages) {
      console.log(`  • ${message}`);
    }
    console.log("  Remova manualmente se não for mais necessário.");
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

/**
 * Atualiza bloco agent-rules versionado e entradas MCP dos hosts sem reindexar.
 * Idempotente: refresh repetido é no-op quando versão/path já convergem.
 * Respeita `ARGUS_NO_INSTALL_REFRESH` (opt-out) — informa ação manual sem mutar.
 */
export function runInstallRefresh(options: InstallRefreshOptions = {}): {
  code: number;
  summary: InstallRefreshSummary;
} {
  const cwd = process.cwd();
  const messages: string[] = [];

  if (isInstallRefreshOptedOut()) {
    const manualHint =
      `Remova ${ARGUS_NO_INSTALL_REFRESH_ENV} e rode \`argus install --refresh\` ` +
      `para atualizar agent-rules e entradas MCP.`;
    messages.push(
      `${ARGUS_NO_INSTALL_REFRESH_ENV} ativo — refresh automático ignorado (sem mutação).`,
    );
    messages.push(manualHint);
    for (const line of messages) {
      console.log(line);
    }
    return {
      code: 0,
      summary: {
        skipped: true,
        optOut: true,
        manualHint,
        messages,
      },
    };
  }

  let handle: ReturnType<typeof requireWorkspaceRoot>;
  try {
    handle = requireWorkspaceRoot(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    return {
      code: 1,
      summary: { skipped: false, optOut: false, messages: [msg] },
    };
  }
  const root = handle.rootPath;

  // Se o heal substituiu um root ainda registrado, troca a entrada sem apagar
  // o estado sombra. Refresh não passa a registrar repos que nunca usaram daemon.
  replaceHealedRegistryRoot(handle, false);

  // Heal D4: root já está canonicalizado pelo requireWorkspaceRoot.
  // Agent-rules e MCP usam o root canônico, não o cwd de discovery.
  const rules = installAgentRules(root);
  for (const { name, action } of rules.files) {
    messages.push(
      action === "unchanged"
        ? `${name}: agent-rules já na versão corrente`
        : `${name}: agent-rules ${action === "created" ? "criadas" : "atualizadas"}`,
    );
  }

  let mcp: HostRegistrationResult[] | undefined;
  let hadPartialFailure = false;
  if (!options.noMcp) {
    const hosts = options.hosts ?? resolveDefaultHosts(root, options.scope);
    mcp = registerMcpForHosts(root, hosts, options.scope);
    for (const r of mcp) {
      messages.push(`MCP ${r.message}`);
      console.log(`  MCP ${r.message}`);
    }
    const failed = mcp.filter((r) => !r.ok);
    if (failed.length > 0) {
      hadPartialFailure = true;
    }
  }

  // Diagnóstico de sombra (D5): reporta sem apagar
  const shadowMessages = formatShadowDiagnostic(handle);
  if (shadowMessages.length > 0) {
    messages.push("⚠ .argus sombra detectado (não removido automaticamente — D5)");
    messages.push(...shadowMessages);
  }

  const restartHint =
    "Reinicie o processo MCP do host para carregar ListTools/entrada atualizados.";
  messages.push(restartHint);

  console.log("\n✓ Argus refresh:");
  for (const item of messages) {
    if (!item.startsWith("MCP ")) {
      console.log(`  • ${item}`);
    }
  }

  const summary: InstallRefreshSummary = {
    skipped: false,
    optOut: false,
    rules,
    mcp,
    restartHint,
    messages,
  };

  if (hadPartialFailure) {
    console.log("\nRefresh concluído com pendências em um ou mais hosts — demais preservados.");
    return { code: 1, summary };
  }
  return { code: 0, summary };
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

  // Resolve+heal para obter o root canônico (D4). Purge e unregister usam root.
  let handle: ReturnType<typeof requireWorkspaceRoot>;
  try {
    handle = requireWorkspaceRoot(cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const root = handle.rootPath;

  // Sem `--hosts`, tenta todos os suportados (no-op quando não registrado), pra
  // não deixar resíduo em nenhum host.
  const hosts = options.hosts ?? SUPPORTED_HOSTS;

  unregisterWorkspace(root);
  if (handle.previousRootPath) {
    unregisterWorkspace(handle.previousRootPath);
  }
  for (const r of unregisterMcpForHosts(root, hosts, options.scope)) {
    console.log(`  MCP ${r.message}`);
  }
  runAgentRulesUninstall(root);
  runHookUninstall(root);

  // Se nenhum workspace resta, remove o serviço global do daemon.
  if (listWorkspaceRoots().length === 0) {
    const service = uninstallService();
    console.log(`  ${service.message}`);
  } else if (isDaemonRunning()) {
    runDaemonReload();
  }

  if (options.purge) {
    rmSync(getWorkspacePath(root), { recursive: true, force: true });
    console.log("  .argus/ removido (--purge)");

    // Diagnóstico de sombra (D5): reporta sem apagar
    const shadowMessages = formatShadowDiagnostic(handle);
    if (shadowMessages.length > 0) {
      console.log("\n⚠ .argus sombra detectado (não removido automaticamente — D5):");
      for (const message of shadowMessages) {
        console.log(`  • ${message}`);
      }
      console.log("  Remova manualmente se não for mais necessário.");
    }
  }

  console.log("\n✓ Argus desinstalado deste repositório.");
  return 0;
}
