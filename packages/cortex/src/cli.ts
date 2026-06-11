#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runIndex } from "./commands/index-cmd.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";
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
  .action(() => {
    process.exit(runIndex());
  });

program
  .command("sync")
  .description("Sincronização incremental do manifest local")
  .action(() => {
    process.exit(runSync());
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
