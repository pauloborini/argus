import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { requireWorkspace } from "../workspace/workspace.js";

const BLOCK_BEGIN = "# >>> atlas-cortex >>>";
const BLOCK_END = "# <<< atlas-cortex <<<";

/** Hooks git que disparam marcação de dirty, com o ref base de cada evento. */
const HOOKS: { name: string; baseExpr: string }[] = [
  // Pós-commit: base = pai do commit recém-criado.
  { name: "post-commit", baseExpr: "HEAD~1" },
  // Pós-merge: base = HEAD anterior ao merge.
  { name: "post-merge", baseExpr: "ORIG_HEAD" },
  // Pós-checkout: git passa $1=prev $2=new $3=flag(1 se troca de branch).
  { name: "post-checkout", baseExpr: "$1" },
];

function resolveGitHooksDir(rootPath: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? join(rootPath, out) : null;
  } catch {
    return null;
  }
}

/** Caminho absoluto do CLI compilado (cli.js), a partir deste módulo. */
function resolveCliEntry(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

/** Aspas simples seguras para sh: protege espaços, `$`, backtick e aspas. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildBlock(baseExpr: string, hookName: string, rootPath: string): string {
  const node = shQuote(process.execPath);
  const cli = shQuote(resolveCliEntry());
  const root = shQuote(rootPath);
  // post-checkout só marca em troca de branch ($3 == 1), não em checkout de arquivo.
  const guard =
    hookName === "post-checkout"
      ? '[ "$3" = "1" ] || exit 0\n'
      : "";
  // Roda no root do WORKSPACE cortex (não no git toplevel): em monorepo o
  // `.cortex` pode estar num subdiretório, e `cortex` resolve o workspace a
  // partir do cwd. `cd` para o git toplevel tornaria `mark-dirty` um no-op.
  // Base inválida (ex.: primeiro commit sem pai) → marca sem --since (force full).
  return [
    BLOCK_BEGIN,
    "# Gerado por `cortex hook install`. Não edite à mão.",
    `cd ${root} || exit 0`,
    guard +
      `if base=$(git rev-parse --verify --quiet "${baseExpr}^{commit}" 2>/dev/null); then`,
    `  ${node} ${cli} mark-dirty --since "$base" >/dev/null 2>&1 || true`,
    "else",
    `  ${node} ${cli} mark-dirty >/dev/null 2>&1 || true`,
    "fi",
    BLOCK_END,
  ].join("\n");
}

function stripBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) {
      inside = true;
      continue;
    }
    if (line.trim() === BLOCK_END) {
      inside = false;
      continue;
    }
    if (!inside) {
      out.push(line);
    }
  }
  return out.join("\n");
}

function writeHook(hooksDir: string, hookName: string, baseExpr: string, rootPath: string): void {
  const hookPath = join(hooksDir, hookName);
  const block = buildBlock(baseExpr, hookName, rootPath);

  let existing = "";
  if (existsSync(hookPath)) {
    existing = readFileSync(hookPath, "utf-8");
  }

  let body: string;
  if (existing.includes(BLOCK_BEGIN)) {
    // Já instalado: substitui só o bloco, preserva o resto.
    body = stripBlock(existing).replace(/\n{3,}/g, "\n\n").trimEnd();
  } else if (existing.trim().length > 0) {
    // Hook pré-existente do usuário: anexa o bloco.
    body = existing.trimEnd();
  } else {
    body = "#!/bin/sh";
  }

  if (!body.startsWith("#!")) {
    body = `#!/bin/sh\n${body}`;
  }

  const content = `${body}\n\n${block}\n`;
  writeFileSync(hookPath, content, "utf-8");
  chmodSync(hookPath, 0o755);
}

export function runHookInstall(cwd: string = process.cwd()): number {
  let rootPath: string;
  try {
    rootPath = requireWorkspace(cwd).root_path;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const hooksDir = resolveGitHooksDir(rootPath);
  if (!hooksDir) {
    console.error(
      "E_NO_GIT: Repositório git não encontrado. Hooks exigem git; use `cortex sync` manual ou auto-sync do MCP.",
    );
    return 1;
  }

  try {
    mkdirSync(hooksDir, { recursive: true });
    for (const hook of HOOKS) {
      writeHook(hooksDir, hook.name, hook.baseExpr, rootPath);
    }
  } catch (err) {
    console.error(`E_HOOK_INSTALL: Falha ao instalar hooks: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(`Hooks instalados em ${hooksDir}: ${HOOKS.map((h) => h.name).join(", ")}.`);
  console.log("Cada hook só marca o índice como sujo (não roda sync); o commit nunca trava.");
  return 0;
}

export function runHookUninstall(cwd: string = process.cwd()): number {
  let rootPath: string;
  try {
    rootPath = requireWorkspace(cwd).root_path;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const hooksDir = resolveGitHooksDir(rootPath);
  if (!hooksDir) {
    console.log("Nenhum diretório de hooks git; nada a desinstalar.");
    return 0;
  }

  let removed = 0;
  for (const hook of HOOKS) {
    const hookPath = join(hooksDir, hook.name);
    if (!existsSync(hookPath)) {
      continue;
    }
    const existing = readFileSync(hookPath, "utf-8");
    if (!existing.includes(BLOCK_BEGIN)) {
      continue;
    }
    const stripped = stripBlock(existing).replace(/\n{3,}/g, "\n\n").trimEnd();
    if (stripped.trim() === "#!/bin/sh" || stripped.trim().length === 0) {
      // Bloco era o único conteúdo: deixa um hook vazio inofensivo.
      writeFileSync(hookPath, "#!/bin/sh\n", "utf-8");
    } else {
      writeFileSync(hookPath, `${stripped}\n`, "utf-8");
    }
    removed += 1;
  }

  console.log(`Hooks cortex removidos: ${removed}. Hooks pré-existentes do usuário preservados.`);
  return 0;
}
