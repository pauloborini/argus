import { readFileSync } from "node:fs";
import { VaultEngine } from "../memory/vault-engine.js";
import { DreamEngine } from "../memory/dream-engine.js";
import { serializePayload } from "../output.js";

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

export function runMemoryInit(): number {
  try {
    return print(VaultEngine.init());
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
    const content = options.stdin ? await readStdin() : options.file ? "" : text ?? "";
    return print(
      VaultEngine.remember(content, {
        file: options.file,
        type: options.type,
        tags: options.tag,
        links: options.link,
      }),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemorySync(): number {
  try {
    return print(VaultEngine.sync());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runMemoryEmbed(): Promise<number> {
  try {
    return print(await VaultEngine.embed());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemorySearch(query: string, options?: { limit?: number }): number {
  try {
    return print(VaultEngine.search(query, { limit: options?.limit }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runMemoryDream(): Promise<number> {
  try {
    return print(await DreamEngine.run());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemoryDoctor(): number {
  try {
    return print({ memory: VaultEngine.status(), ...VaultEngine.search("__argus_doctor_probe__", { limit: 1 }) });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function runMemoryRebuild(): number {
  try {
    return print(VaultEngine.rebuild());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function readMemoryFile(path: string): string {
  return readFileSync(path, "utf-8");
}
