import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireWorkspace } from "../workspace/workspace.js";

const BLOCK_BEGIN = "<!-- >>> argus >>> -->";
const BLOCK_END = "<!-- <<< argus <<< -->";

const TARGET_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

const RULES_BODY = `## Argus

Este repositório tem um índice local Argus (\`.argus/\`). Antes de varrer
o código com grep/leitura repetida, use as tools do argus — elas respondem
perguntas estruturais a partir do índice:

- \`search\` — achar símbolo por nome.
- \`explore\` — contexto estrutural de símbolo/arquivo/tema.
- \`trace\` / \`impact\` / \`diff_impact\` — fluxo, raio de impacto e impacto do diff.
- \`files\` — estrutura indexada.
- \`pack_context\` / \`retrieve\` — empacotar e reidratar contexto.
- \`status\` — saúde e staleness do índice.

O índice é mantido fresco automaticamente: hooks git marcam mudanças e o
servidor MCP roda sync incremental antes de responder. Não é preciso rodar
\`argus sync\` manualmente no fluxo normal. Se um resultado vier com
\`state: parcial\` e \`staleness_hint\`, rode \`argus sync\` e repita.`;

function buildBlock(): string {
  return `${BLOCK_BEGIN}\n${RULES_BODY}\n${BLOCK_END}`;
}

function stripBlock(content: string): string {
  const begin = content.indexOf(BLOCK_BEGIN);
  if (begin === -1) {
    return content;
  }
  const end = content.indexOf(BLOCK_END, begin);
  if (end === -1) {
    return content.slice(0, begin).trimEnd();
  }
  const before = content.slice(0, begin).trimEnd();
  const after = content.slice(end + BLOCK_END.length).trimStart();
  return [before, after].filter((part) => part.length > 0).join("\n\n");
}

function writeRules(filePath: string): "created" | "updated" {
  const block = buildBlock();
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${block}\n`, "utf-8");
    return "created";
  }
  const existing = readFileSync(filePath, "utf-8");
  const base = stripBlock(existing).trimEnd();
  const content = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  writeFileSync(filePath, content, "utf-8");
  return "updated";
}

export function runAgentRulesInstall(cwd: string = process.cwd()): number {
  let rootPath: string;
  try {
    rootPath = requireWorkspace(cwd).root_path;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  for (const name of TARGET_FILES) {
    const filePath = join(resolve(rootPath), name);
    const action = writeRules(filePath);
    console.log(`${name}: regras argus ${action === "created" ? "criadas" : "atualizadas"}.`);
  }
  console.log("Bloco delimitado por marcadores; conteúdo existente preservado.");
  return 0;
}

export function runAgentRulesUninstall(cwd: string = process.cwd()): number {
  let rootPath: string;
  try {
    rootPath = requireWorkspace(cwd).root_path;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  for (const name of TARGET_FILES) {
    const filePath = join(resolve(rootPath), name);
    if (!existsSync(filePath)) {
      continue;
    }
    const existing = readFileSync(filePath, "utf-8");
    if (!existing.includes(BLOCK_BEGIN)) {
      continue;
    }
    const stripped = stripBlock(existing).trimEnd();
    writeFileSync(filePath, stripped.length > 0 ? `${stripped}\n` : "", "utf-8");
    console.log(`${name}: regras argus removidas.`);
  }
  return 0;
}
