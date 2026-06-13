#!/usr/bin/env node
import { Command } from "commander";
import { runDiffImpact } from "./commands/diff-impact.js";
import { runFiles } from "./commands/files.js";
import { runExplore } from "./commands/explore.js";
import { runImpact } from "./commands/impact.js";
import { runInit } from "./commands/init.js";
import { runIndex } from "./commands/index-cmd.js";
import { runPackContext } from "./commands/pack-context.js";
import { runSearch } from "./commands/search.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";
import { runTrace } from "./commands/trace.js";
import { runServeMcp } from "./commands/serve.js";

const program = new Command();

program
  .name("cortex")
  .description("Atlas Cortex — CLI local de retrieval e context packing")
  .version("0.1.0");

program
  .command("init")
  .description("Preparar workspace e metadados locais em .cortex/")
  .action(() => {
    process.exit(runInit());
  });

program
  .command("index")
  .description("Indexação completa do inventário local de arquivos")
  .action(async () => {
    process.exit(await runIndex());
  });

program
  .command("sync")
  .description("Sincronização incremental do manifest local")
  .action(async () => {
    process.exit(await runSync());
  });

program
  .command("search")
  .description("Buscar símbolos indexados via FTS local")
  .argument("<query>", "Query textual para localizar símbolos")
  .option("--limit <n>", "Máximo de candidatos", (value) => Number(value))
  .action((query: string, opts: { limit?: number }) => {
    process.exit(runSearch(query, opts));
  });

program
  .command("files")
  .description("Listar estrutura indexada do workspace")
  .option("--pattern <pattern>", "Filtro simples por substring do path")
  .option("--max-depth <n>", "Profundidade máxima por path", (value) => Number(value))
  .action((opts: { pattern?: string; maxDepth?: number }) => {
    process.exit(runFiles(opts));
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
      process.exit(runExplore(target, opts));
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
    process.exit(runTrace(opts.from, opts));
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
      process.exit(runImpact(target, opts));
    },
  );

program
  .command("diff-impact")
  .description("Estimar impacto provável do diff Git atual")
  .option("--scope <scope>", "unstaged | staged | all | compare")
  .option("--base-ref <ref>", "Base Git para comparação quando scope=compare")
  .action((opts: { scope?: string; baseRef?: string }) => {
    process.exit(runDiffImpact(opts));
  });

program
  .command("pack-context")
  .description("Empacotar contexto curto e útil para o modelo")
  .requiredOption("--sources <list>", "Lista CSV de paths, símbolos ou handles")
  .requiredOption("--goal <text>", "Objetivo do pacote para o modelo")
  .requiredOption("--token-budget <n>", "Budget máximo aproximado do pacote", (value) => Number(value))
  .option("--style <style>", "brief | balanced | deep")
  .action((opts: { sources: string; goal: string; tokenBudget: number; style?: string }) => {
    process.exit(
      runPackContext({
        sources: opts.sources.split(",").map((item) => item.trim()).filter(Boolean),
        goal: opts.goal,
        tokenBudget: opts.tokenBudget,
        style: opts.style,
      }),
    );
  });

program
  .command("status")
  .description("Saúde e staleness do manifest local")
  .option("--path <path>", "Subpath ou workspace a inspecionar")
  .action((opts: { path?: string }) => {
    process.exit(runStatus(opts.path));
  });

program
  .command("serve")
  .description("Expor servidor MCP stdio com surface congelada")
  .option("--mcp", "Iniciar servidor MCP stdio (atlas-cortex)")
  .action(async (opts: { mcp?: boolean }) => {
    if (!opts.mcp) {
      console.error("Use --mcp para iniciar o servidor MCP stdio.");
      process.exit(1);
    }
    const code = await runServeMcp();
    process.exit(code);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
