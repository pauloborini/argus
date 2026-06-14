#!/usr/bin/env node
import { Command } from "commander";
import { runDiffImpact } from "./commands/diff-impact.js";
import { runFiles } from "./commands/files.js";
import { runExplore } from "./commands/explore.js";
import { runImpact } from "./commands/impact.js";
import { runInit } from "./commands/init.js";
import { runIndex } from "./commands/index-cmd.js";
import { runPackContext } from "./commands/pack-context.js";
import { runRetrieve } from "./commands/retrieve.js";
import { runSearch } from "./commands/search.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";
import { runTrace } from "./commands/trace.js";
import { runServeMcp } from "./commands/serve.js";
import { runMarkDirty } from "./commands/mark-dirty.js";
import { runHookInstall, runHookUninstall } from "./commands/hooks.js";
import { runAgentRulesInstall, runAgentRulesUninstall } from "./commands/agent-rules.js";
import { CORTEX_VERSION } from "./version.js";

const program = new Command();

// Define o código de saída sem matar o processo. `process.exit()` corta writes
// assíncronos pendentes em stdout: output grande sobre pipe (CLI scriptável,
// execFileSync) trunca no buffer do SO (~64KB no macOS). Deixar o Node sair
// naturalmente após drenar stdout garante payload completo.
function finish(code: number): void {
  process.exitCode = code;
}

/**
 * Tri-state do respeito a `.gitignore` a partir das flags CLI: `--gitignore`
 * força respeitar, `--include-gitignored` força indexar ignorados, nenhuma →
 * `undefined` (usa o default persistido no workspace).
 */
function resolveGitignoreOverride(opts: {
  gitignore?: boolean;
  includeGitignored?: boolean;
}): boolean | undefined {
  if (opts.gitignore) {
    return true;
  }
  if (opts.includeGitignored) {
    return false;
  }
  return undefined;
}

program
  .name("cortex")
  .description("Atlas Cortex — CLI local de retrieval e context packing")
  .version(CORTEX_VERSION);

program
  .command("init")
  .description("Preparar workspace e metadados locais em .cortex/")
  .action(() => {
    finish(runInit());
  });

program
  .command("index")
  .description("Indexação completa do inventário local de arquivos")
  .option("--gitignore", "Respeitar .gitignore neste run (sobrepõe o workspace)")
  .option("--include-gitignored", "Indexar arquivos gitignored neste run")
  .action(async (opts: { gitignore?: boolean; includeGitignored?: boolean }) => {
    finish(await runIndex({ respectGitignore: resolveGitignoreOverride(opts) }));
  });

program
  .command("sync")
  .description("Sincronização incremental do manifest local")
  .option("--since <ref>", "Delta via git desde <ref> (pula walk completo)")
  .option("--full", "Forçar walk completo (ignora git-delta e dirty-flag)")
  .option("--gitignore", "Respeitar .gitignore neste run (sobrepõe o workspace)")
  .option("--include-gitignored", "Indexar arquivos gitignored neste run")
  .action(
    async (opts: {
      since?: string;
      full?: boolean;
      gitignore?: boolean;
      includeGitignored?: boolean;
    }) => {
      finish(
        await runSync({
          since: opts.since,
          full: opts.full,
          respectGitignore: resolveGitignoreOverride(opts),
        }),
      );
    },
  );

program
  .command("search")
  .description("Buscar símbolos indexados via FTS local")
  .argument("<query>", "Query textual para localizar símbolos")
  .option("--scope <path>", "Restringir candidatos por path")
  .option("--kind <kind>", "Restringir por tipo de símbolo")
  .option("--limit <n>", "Máximo de candidatos", (value) => Number(value))
  .action((query: string, opts: { scope?: string; kind?: string; limit?: number }) => {
    finish(runSearch(query, opts));
  });

program
  .command("files")
  .description("Listar estrutura indexada do workspace")
  .option("--pattern <pattern>", "Filtro simples por substring do path")
  .option("--max-depth <n>", "Profundidade máxima por path", (value) => Number(value))
  .action((opts: { pattern?: string; maxDepth?: number }) => {
    finish(runFiles(opts));
  });

program
  .command("explore")
  .description("Explorar um alvo com contexto estrutural composto")
  .argument("<target>", "Símbolo, arquivo ou tema alvo")
  .option("--mode <mode>", "symbol | file | topic")
  .option("--depth <n>", "Profundidade curta de exploração", (value) => Number(value))
  .option("--include-tests", "Incluir arquivos de teste quando relevantes")
  .option("--budget <n>", "Budget interno de candidatos", (value) => Number(value))
  .action(
    (
      target: string,
      opts: { mode?: string; depth?: number; includeTests?: boolean; budget?: number },
    ) => {
      finish(runExplore(target, opts));
    },
  );

program
  .command("trace")
  .description("Traçar fluxo provável entre pontos indexados")
  .requiredOption("--from <target>", "Símbolo ou arquivo de origem")
  .option("--to <target>", "Símbolo ou arquivo de destino")
  .option("--direction <direction>", "forward | backward | both")
  .option("--max-hops <n>", "Número máximo de hops", (value) => Number(value))
  .action((opts: { from: string; to?: string; direction?: string; maxHops?: number }) => {
    finish(runTrace(opts.from, opts));
  });

program
  .command("impact")
  .description("Estimar blast radius provável de símbolo ou arquivo")
  .argument("<target>", "Símbolo ou arquivo alvo")
  .option("--direction <direction>", "dependents | dependencies | both")
  .option("--depth <n>", "Profundidade máxima do impacto", (value) => Number(value))
  .option("--include-tests", "Incluir arquivos de teste quando relevantes")
  .option("--summary-only", "Retornar foco em resumo e agregados")
  .action(
    (
      target: string,
      opts: { direction?: string; depth?: number; includeTests?: boolean; summaryOnly?: boolean },
    ) => {
      finish(runImpact(target, opts));
    },
  );

program
  .command("diff-impact")
  .description("Estimar impacto provável do diff Git atual")
  .option("--scope <scope>", "unstaged | staged | all | compare")
  .option("--base-ref <ref>", "Base Git para comparação quando scope=compare")
  .action((opts: { scope?: string; baseRef?: string }) => {
    finish(runDiffImpact(opts));
  });

program
  .command("pack-context")
  .description("Empacotar contexto curto e útil para o modelo")
  .requiredOption("--sources <list>", "Lista CSV de paths, símbolos ou handles")
  .requiredOption("--goal <text>", "Objetivo do pacote para o modelo")
  .requiredOption("--token-budget <n>", "Budget máximo aproximado do pacote", (value) => Number(value))
  .option("--style <style>", "brief | balanced | deep")
  .action((opts: { sources: string; goal: string; tokenBudget: number; style?: string }) => {
    finish(
      runPackContext({
        sources: opts.sources.split(",").map((item) => item.trim()).filter(Boolean),
        goal: opts.goal,
        tokenBudget: opts.tokenBudget,
        style: opts.style,
      }),
    );
  });

program
  .command("retrieve")
  .description("Recuperar conteúdo original persistido por retrieve_handle")
  .argument("<handle>", "Handle opaco no formato rh_<16 hex>")
  .action((handle: string) => {
    finish(runRetrieve(handle));
  });

program
  .command("status")
  .description("Saúde e staleness do manifest local")
  .option("--path <path>", "Subpath ou workspace a inspecionar")
  .action((opts: { path?: string }) => {
    finish(runStatus(opts.path));
  });

program
  .command("serve")
  .description("Expor servidor MCP stdio com surface congelada")
  .option("--mcp", "Iniciar servidor MCP stdio (atlas-cortex)")
  .option("--no-auto-sync", "Desligar o sync automático antes de cada tool call")
  .action(async (opts: { mcp?: boolean; autoSync?: boolean }) => {
    if (!opts.mcp) {
      console.error("Use --mcp para iniciar o servidor MCP stdio.");
      process.exit(1);
    }
    const code = await runServeMcp({ autoSync: opts.autoSync !== false });
    if (code !== 0) {
      process.exit(code);
    }
  });

program
  .command("mark-dirty")
  .description("Marcar o índice como sujo (uso interno dos hooks git)")
  .option("--since <ref>", "Ref git base do evento")
  .action((opts: { since?: string }) => {
    finish(runMarkDirty({ since: opts.since }));
  });

const hook = program.command("hook").description("Gerenciar hooks git de baixo atrito");
hook
  .command("install")
  .description("Instalar hooks git que marcam o índice como sujo")
  .action(() => {
    finish(runHookInstall());
  });
hook
  .command("uninstall")
  .description("Remover hooks git do cortex (preserva hooks do usuário)")
  .action(() => {
    finish(runHookUninstall());
  });

const agentRules = program
  .command("agent-rules")
  .description("Gerenciar regras de agente em CLAUDE.md / AGENTS.md");
agentRules
  .command("install")
  .description("Escrever bloco de regras cortex em CLAUDE.md e AGENTS.md")
  .action(() => {
    finish(runAgentRulesInstall());
  });
agentRules
  .command("uninstall")
  .description("Remover bloco de regras cortex de CLAUDE.md e AGENTS.md")
  .action(() => {
    finish(runAgentRulesUninstall());
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
