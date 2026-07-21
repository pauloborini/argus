import { readFileSync } from "node:fs";
import { VaultEngine } from "../memory/vault-engine.js";
import { DreamEngine } from "../memory/dream-engine.js";
import { serializePayload } from "../output.js";
import { requireWorkspace } from "../workspace/workspace.js";
import {
  healRootPathIfNeeded,
  W_WORKSPACE_ROOT_HEALED,
} from "../workspace/resolve-workspace.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function print(payload: { state?: unknown; [key: string]: unknown }): number {
  console.log(serializePayload(payload));
  return payload.state === "falha" ? 1 : 0;
}

/**
 * Resolve o root canônico do workspace antes de I/O de memória.
 * Heal D4 local (sem walk-up — Plano 4); CLI memory opera no mesmo `.argus` do índice.
 */
function resolveMemoryRoot(): string {
  const startCwd = process.cwd();
  const metadata = requireWorkspace(startCwd);
  const { metadata: healedMeta, healed } = healRootPathIfNeeded(startCwd, metadata);
  if (healed) {
    process.stderr.write(
      `${W_WORKSPACE_ROOT_HEALED}: root_path alinhado para ${healedMeta.root_path} (antes: ${metadata.root_path}).\n`,
    );
  }
  return healedMeta.root_path;
}

export function runMemoryInit(): number {
  try {
    return print(VaultEngine.init(resolveMemoryRoot()));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runMemoryRemember(
  text: string | undefined,
  options: { stdin?: boolean; file?: string; type?: string; tag?: string[]; link?: string[] },
): Promise<number> {
  try {
    const rootPath = resolveMemoryRoot();
    const content = options.stdin ? await readStdin() : options.file ? "" : text ?? "";
    return print(
      await VaultEngine.remember(content, {
        file: options.file,
        type: options.type,
        tags: options.tag,
        links: options.link,
      }, rootPath),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemorySync(): number {
  try {
    return print(VaultEngine.sync(resolveMemoryRoot()));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runMemoryEmbed(): Promise<number> {
  try {
    return print(await VaultEngine.embed(resolveMemoryRoot()));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemorySearch(query: string, options?: { limit?: number }): number {
  try {
    return print(VaultEngine.search(query, { limit: options?.limit }, resolveMemoryRoot()));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runMemoryDream(): Promise<number> {
  try {
    return print(await DreamEngine.run(resolveMemoryRoot()));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemoryDoctor(): number {
  try {
    const rootPath = resolveMemoryRoot();
    return print({
      memory: VaultEngine.status(rootPath),
      ...VaultEngine.search("__argus_doctor_probe__", { limit: 1 }, rootPath),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemoryRebuild(): number {
  try {
    return print(VaultEngine.rebuild(resolveMemoryRoot()));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function readMemoryFile(path: string): string {
  return readFileSync(path, "utf-8");
}
