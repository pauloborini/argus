import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LISTED_MCP_TOOLS } from "../mcp/tool-registry.js";
import { requireWorkspace } from "../workspace/workspace.js";

export const BLOCK_BEGIN = "<!-- >>> argus >>> -->";
export const BLOCK_END = "<!-- <<< argus <<< -->";

/**
 * Versão do corpo gerado (independente do semver do pacote).
 * Bump quando o texto/contrato do path feliz mudar — `install --refresh` detecta drift.
 */
export const AGENT_RULES_VERSION = 3;

/** Marcador parseável dentro do bloco (ex.: `<!-- argus-agent-rules-version: 1 -->`). */
export const AGENT_RULES_VERSION_MARKER_RE =
  /<!--\s*argus-agent-rules-version:\s*(\d+)\s*-->/;

const TARGET_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

function happyPathToolsLine(): string {
  return DEFAULT_LISTED_MCP_TOOLS.map((name) => `\`${name}\``).join(", ");
}

/**
 * Corpo versionado alinhado ao ListTools slim (D1 / INV-H2).
 * Path feliz = explore → pack_context → recall → remember → status; CLI como fallback.
 */
export function buildRulesBody(version: number = AGENT_RULES_VERSION): string {
  const listed = happyPathToolsLine();
  return `## Argus

<!-- argus-agent-rules-version: ${version} -->

Este repositório tem um índice local Argus (\`.argus/\`). Antes de varrer
o código com grep/leitura repetida, prefira as tools do path feliz
(listadas por default no MCP — as mesmas de ListTools slim): ${listed}.

Decisão operacional:

1. \`explore\` — primeira escolha para entender símbolo, arquivo ou tema.
2. \`pack_context\` — reunir múltiplas fontes (código + memória) sob budget.
3. \`recall\` — recuperar decisões/regras já capturadas; use antes de inventar regra de projeto.
4. \`remember\` — ao fechar uma decisão ou insight, capture no cofre
   (MCP \`remember\` ou CLI \`argus memory remember\`).
5. \`status\` — saúde, staleness e modo slim da surface MCP.

Fallback CLI (quando o MCP não estiver disponível): \`argus explore\`,
\`argus pack-context\`, \`argus memory search\` (equiv. recall),
\`argus memory remember\`, \`argus status\`.

Memória local no mesmo estado \`.argus/\`:

- \`remember\` / \`recall\` — captura e busca no cofre sem LLM.
- \`pack_context\` aceita código + memória; prefira um pacote a várias leituras.
- Fatos promovidos do Talos HANDOFF usam shape nativa \`content\` / \`type\` / \`tags\` / \`links\`
  (ver \`docs/MEMORY_V2_CONTRACT.md\` §11). Tags mínimas: \`talos-handoff\` + \`anchor:<tipo>:<valor>\` quando houver âncora.
- Loop handoff → \`remember\` → \`recall\`: após promote, prefira \`recall\` antes de inventar regra.
- Ref 1+1: 1 leitura do path \`ref\` → 1 name search pelo basename → se falhar, seguir só com o fato (não trava).
- Nunca invente \`argus learn\`, receipt JSON ou API nova de ingestão — só \`remember\` / \`recall\` existentes.

Tools avançadas (\`search\`, \`trace\`, \`impact\`, \`diff_impact\`, \`files\`,
\`retrieve\`, \`semantic_search\`) continuam invocáveis via CallTool
ou CLI mesmo quando não listadas. Para ListTools completo:
\`ARGUS_MCP_TOOLS=all\` (exige restart do MCP).

O índice é mantido fresco automaticamente: hooks git marcam mudanças e o
servidor MCP roda sync incremental antes de responder. Não é preciso rodar
\`argus sync\` manualmente no fluxo normal. Se um resultado vier com
\`state: parcial\` e \`staleness_hint\`, rode \`argus sync\` e repita.`;
}

export function buildBlock(version: number = AGENT_RULES_VERSION): string {
  return `${BLOCK_BEGIN}\n${buildRulesBody(version)}\n${BLOCK_END}`;
}

/** Extrai a versão do marcador; `null` = bloco ausente ou legado sem versão. */
export function parseAgentRulesVersion(content: string): number | null {
  const begin = content.indexOf(BLOCK_BEGIN);
  if (begin === -1) {
    return null;
  }
  const end = content.indexOf(BLOCK_END, begin);
  const region = end === -1 ? content.slice(begin) : content.slice(begin, end);
  const match = region.match(AGENT_RULES_VERSION_MARKER_RE);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

/**
 * Remove somente o bloco Argus, preservando bytes fora dos marcadores.
 * Ajusta no máximo um `\n` de junção imediato após o fim do bloco para evitar
 * linha em branco órfã deixada pelos marcadores — sem alterar o texto do usuário.
 */
export function stripBlock(content: string): string {
  const begin = content.indexOf(BLOCK_BEGIN);
  if (begin === -1) {
    return content;
  }
  const end = content.indexOf(BLOCK_END, begin);
  if (end === -1) {
    return content.slice(0, begin);
  }
  const before = content.slice(0, begin);
  let after = content.slice(end + BLOCK_END.length);
  // Bloco costuma ser seguido de `\n`; remove só esse separador imediato.
  if (after.startsWith("\n")) {
    after = after.slice(1);
  }
  return before + after;
}

export type RulesWriteAction = "created" | "updated" | "unchanged";

/**
 * Escreve/substitui o bloco versionado. Conteúdo fora dos marcadores permanece
 * byte a byte (antes/depois do bloco). Install repetido com corpo idêntico é no-op.
 */
export function writeRules(filePath: string): RulesWriteAction {
  const block = buildBlock();
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${block}\n`, "utf-8");
    return "created";
  }
  const existing = readFileSync(filePath, "utf-8");
  const begin = existing.indexOf(BLOCK_BEGIN);
  if (begin === -1) {
    const needsNl = existing.length > 0 && !existing.endsWith("\n");
    const sep = existing.length > 0 ? "\n" : "";
    const next = `${existing}${needsNl ? "\n" : ""}${sep}${block}\n`;
    writeFileSync(filePath, next, "utf-8");
    return "updated";
  }
  const end = existing.indexOf(BLOCK_END, begin);
  if (end === -1) {
    const before = existing.slice(0, begin);
    const next = `${before}${block}\n`;
    if (next === existing) {
      return "unchanged";
    }
    writeFileSync(filePath, next, "utf-8");
    return "updated";
  }
  const before = existing.slice(0, begin);
  const after = existing.slice(end + BLOCK_END.length);
  // Preserva o after exatamente (incl. `\n` pós-marcador, se houver).
  const next = `${before}${block}${after}`;
  if (next === existing) {
    return "unchanged";
  }
  writeFileSync(filePath, next, "utf-8");
  return "updated";
}

export interface AgentRulesInstallSummary {
  files: Array<{ name: string; action: RulesWriteAction }>;
}

export function installAgentRules(cwd: string = process.cwd()): AgentRulesInstallSummary {
  const rootPath = requireWorkspace(cwd).root_path;
  const files: AgentRulesInstallSummary["files"] = [];
  for (const name of TARGET_FILES) {
    const filePath = join(resolve(rootPath), name);
    files.push({ name, action: writeRules(filePath) });
  }
  return { files };
}

export function runAgentRulesInstall(cwd: string = process.cwd()): number {
  let summary: AgentRulesInstallSummary;
  try {
    summary = installAgentRules(cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  for (const { name, action } of summary.files) {
    if (action === "unchanged") {
      console.log(`${name}: regras argus já atualizadas.`);
    } else {
      console.log(`${name}: regras argus ${action === "created" ? "criadas" : "atualizadas"}.`);
    }
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
    const stripped = stripBlock(existing);
    // Evita arquivo só com whitespace residual; preserva texto do usuário.
    const out = stripped.trim().length === 0 ? "" : stripped.endsWith("\n") ? stripped : `${stripped}\n`;
    writeFileSync(filePath, out, "utf-8");
    console.log(`${name}: regras argus removidas.`);
  }
  return 0;
}
