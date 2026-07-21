/**
 * Persistência compartilhada de retrieve_handle (`rh_*` / `mh_*`).
 * Owner único usado por pack_context e explore — mesmo formato e eviction.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeIndexDb, openIndexDb } from "../../storage/sqlite-index-store.js";
import { getIndexDbPath } from "../../workspace/workspace.js";
import { isWithinPath } from "./common.js";
import type {
  PackSegment,
  ReadStoredPackHandleResult,
  StoredPackHandle,
} from "./common.js";

export type RetrieveHandleStyle = "brief" | "balanced" | "deep";

export interface WriteStoredRetrieveHandlePayload {
  handle: string;
  created_at: string;
  goal: string;
  style: RetrieveHandleStyle;
  token_budget: number;
  manifest_hash?: string | null;
  schema_version?: string | null;
  segments: PackSegment[];
}

export function getPackedHandlesDir(cwd: string): string {
  return join(cwd, ".argus", "packed-handles");
}

export function getPackedHandlePath(cwd: string, handle: string): string {
  return join(getPackedHandlesDir(cwd), handle);
}

export function isValidRetrieveHandle(handle: string): boolean {
  return /^(rh|mh)_[a-f0-9]{16}$/.test(handle);
}

/** Gera handle opaco `rh_<16hex>` ou `mh_<16hex>`. */
export function createRetrieveHandleId(prefix: "rh" | "mh" = "rh"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function compareReversibility(
  left: ReadStoredPackHandleResult["reversibility"],
  right: ReadStoredPackHandleResult["reversibility"],
): ReadStoredPackHandleResult["reversibility"] {
  const order = { full: 0, partial: 1, none: 2 } as const;
  return order[left] >= order[right] ? left : right;
}

function registerPackedHandleInIndex(cwd: string, handle: string, createdAt: string): void {
  try {
    const db = openIndexDb(getIndexDbPath(cwd));
    try {
      db.prepare("INSERT OR REPLACE INTO packed_handles (handle, created_at) VALUES (?, ?)").run(
        handle,
        createdAt,
      );
    } finally {
      closeIndexDb(db);
    }
  } catch {
    // best effort; filesystem persistence remains source of truth for MVP
  }
}

// GC de retrieve handles: `.argus/packed-handles/` crescia sem limite (um
// diretório por pack com perda de budget). Evicção por idade (TTL) e por
// contagem (cap dos mais recentes), disparada ao gravar um novo handle.
const PACKED_HANDLE_MAX = 50;

const PACKED_HANDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function evictStalePackedHandles(cwd: string, protectedHandle: string): void {
  try {
    const db = openIndexDb(getIndexDbPath(cwd));
    try {
      const rows = db
        .prepare(
          `SELECT handle, created_at FROM packed_handles
           ORDER BY CASE WHEN handle = ? THEN 0 ELSE 1 END, created_at DESC, id DESC`,
        )
        .all(protectedHandle) as Array<{ handle: string; created_at: string }>;
      const now = Date.now();
      const del = db.prepare("DELETE FROM packed_handles WHERE handle = ?");
      const handlesDir = getPackedHandlesDir(cwd);
      let retained = 0;
      rows.forEach((row) => {
        const parsed = Date.parse(row.created_at);
        const isProtected = row.handle === protectedHandle;
        const tooOld = !isProtected && Number.isFinite(parsed) && now - parsed > PACKED_HANDLE_TTL_MS;
        const overflow = !isProtected && retained >= PACKED_HANDLE_MAX;
        if (!tooOld && !overflow) {
          retained += 1;
          return;
        }
        if (isValidRetrieveHandle(row.handle)) {
          const dir = getPackedHandlePath(cwd, row.handle);
          if (isWithinPath(handlesDir, dir)) {
            rmSync(dir, { recursive: true, force: true });
          }
        }
        del.run(row.handle);
      });
    } finally {
      closeIndexDb(db);
    }
  } catch {
    // best effort; nunca falha o writer por causa da limpeza
  }
}

export function readStoredPackHandle(cwd: string, handle: string): ReadStoredPackHandleResult {
  if (!isValidRetrieveHandle(handle)) {
    return {
      found: false,
      segments: [],
      limitations: ["Retrieve handle inválido."],
      reversibility: "none",
    };
  }
  const handleDir = getPackedHandlePath(cwd, handle);
  const manifestPath = join(handleDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      found: false,
      segments: [],
      limitations: [],
      reversibility: "none",
    };
  }

  let manifest: StoredPackHandle;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as StoredPackHandle;
  } catch {
    return {
      found: true,
      segments: [],
      limitations: [`Retrieve handle corrompido: ${handle}.`],
      reversibility: "none",
    };
  }
  if (!Array.isArray(manifest.segments)) {
    return {
      found: true,
      segments: [],
      limitations: [`Retrieve handle corrompido: ${handle}.`],
      reversibility: "none",
    };
  }

  const limitations: string[] = [];
  const segments: PackSegment[] = [];
  let reversibility: ReadStoredPackHandleResult["reversibility"] = "full";

  for (const segment of manifest.segments) {
    if (
      !segment ||
      typeof segment.ref !== "string" ||
      !Array.isArray(segment.originRefs) ||
      typeof segment.body_file !== "string"
    ) {
      limitations.push(`Segmento inválido no retrieve_handle ${handle}.`);
      reversibility = compareReversibility(reversibility, "partial");
      continue;
    }
    const bodyPath = join(handleDir, segment.body_file);
    if (!isWithinPath(handleDir, bodyPath) || !isWithinPath(cwd, bodyPath)) {
      limitations.push(`Segmento fora do workspace rejeitado para retrieve_handle ${handle}.`);
      reversibility = compareReversibility(reversibility, "partial");
      continue;
    }
    if (!existsSync(bodyPath)) {
      limitations.push(`Segmento ausente para retrieve_handle ${handle}: ${segment.ref}.`);
      reversibility = compareReversibility(reversibility, "partial");
      continue;
    }

    try {
      const text = readFileSync(bodyPath, "utf-8");
      segments.push({
        ref: segment.ref,
        text,
        originRefs: segment.originRefs,
      });
    } catch {
      limitations.push(`Falha ao ler segmento persistido de ${handle}: ${segment.ref}.`);
      reversibility = compareReversibility(reversibility, "partial");
    }
  }

  if (segments.length === 0) {
    reversibility = "none";
  }

  return {
    found: true,
    segments,
    limitations,
    reversibility,
  };
}

/**
 * Grava segmentos recuperáveis sob `.argus/packed-handles/<handle>/`.
 * API única de escrita — pack e explore devem passar por aqui.
 */
export function writeStoredPackHandle(
  cwd: string,
  payload: WriteStoredRetrieveHandlePayload,
): ReadStoredPackHandleResult["reversibility"] {
  const handleDir = getPackedHandlePath(cwd, payload.handle);
  rmSync(handleDir, { recursive: true, force: true });
  mkdirSync(handleDir, { recursive: true });

  const manifest: StoredPackHandle = {
    handle: payload.handle,
    created_at: payload.created_at,
    goal: payload.goal,
    style: payload.style,
    token_budget: payload.token_budget,
    manifest_hash: payload.manifest_hash,
    schema_version: payload.schema_version,
    segments: [],
  };

  let reversibility: ReadStoredPackHandleResult["reversibility"] = "full";

  for (const [index, segment] of payload.segments.entries()) {
    const bodyFile = `segment-${String(index + 1).padStart(3, "0")}.txt`;
    const bodyPath = join(handleDir, bodyFile);
    try {
      writeFileSync(bodyPath, segment.text, "utf-8");
      manifest.segments.push({
        ref: segment.ref,
        originRefs: segment.originRefs,
        body_file: bodyFile,
      });
    } catch {
      reversibility = compareReversibility(reversibility, "partial");
    }
  }

  try {
    writeFileSync(join(handleDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  } catch {
    return "none";
  }

  registerPackedHandleInIndex(cwd, payload.handle, payload.created_at);
  evictStalePackedHandles(cwd, payload.handle);
  if (manifest.segments.length === 0) {
    return "none";
  }
  return reversibility;
}
