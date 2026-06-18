import { statSync } from "node:fs";
import type { DiscoveryManifest } from "./types.js";
import { discoverFiles } from "./walk.js";
import { readDirtyFlag } from "./dirty-flag.js";
import { readManifest } from "./manifest.js";
import {
  getDirtyFlagPath,
  getManifestPath,
  readWorkspaceMetadata,
  resolveRespectGitignore,
} from "../workspace/workspace.js";

export type ManifestStaleness = "fresh" | "stale" | "unknown";

export interface StalenessResult {
  staleness: ManifestStaleness;
  pending_files_count: number;
}

export interface ComputeStalenessOptions {
  /** Deve casar com o valor usado na indexação, senão o recheck gera falso stale. */
  respect_gitignore?: boolean;
}

/** mtime do arquivo em ms, ou `0` se ausente/ilegível. */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Memo por workspace para coalescer o walk em rajadas de tool calls (o servidor
// MCP é longevo: várias chamadas em sequência sobre o mesmo índice). Invalidado
// por mudança de assinatura (mtime do manifest/dirty-flag) ou por TTL — o TTL
// limita o mascaramento de edições de working-tree fora de daemon/hooks à
// janela abaixo.
const STALENESS_MEMO_TTL_MS = 1_000;
interface StalenessMemo {
  signature: string;
  result: StalenessResult;
  expiresAt: number;
}
const stalenessMemo = new Map<string, StalenessMemo>();

export function computeManifestStaleness(
  rootPath: string,
  manifest: DiscoveryManifest,
  options: ComputeStalenessOptions = {},
): StalenessResult {
  // Curto-circuito barato: dirty-flag pendente = stale conhecido, sem walk.
  // Cobre o caminho CLI (sem auto-sync) e a janela em que um sync falhou.
  const dirty = readDirtyFlag(rootPath);
  if (dirty && (dirty.paths.length > 0 || dirty.force_full)) {
    return { staleness: "stale", pending_files_count: dirty.paths.length };
  }

  // Memo: pula o walk quando nada mudou desde a última checagem (mesma
  // assinatura) dentro do TTL.
  const signature = `${mtimeMs(getManifestPath(rootPath))}:${mtimeMs(
    getDirtyFlagPath(rootPath),
  )}:${options.respect_gitignore ? 1 : 0}`;
  const now = Date.now();
  const cached = stalenessMemo.get(rootPath);
  if (cached && cached.signature === signature && cached.expiresAt > now) {
    return cached.result;
  }

  const result = computeStalenessUncached(rootPath, manifest, options);
  stalenessMemo.set(rootPath, {
    signature,
    result,
    expiresAt: now + STALENESS_MEMO_TTL_MS,
  });
  return result;
}

/**
 * Probe barato para o auto-sync do MCP: o working tree divergiu do manifest?
 * Fecha o Bug 9 — com daemon down e sem hooks a dirty-flag nunca é alimentada,
 * então o auto-sync gated em `hasDirtyPaths` jamais dispara e o índice fica
 * stale para sempre (até `cortex sync` manual). Reusa o memo de
 * `computeManifestStaleness` (mesma assinatura por root), então não adiciona
 * walk quando a tool já vai computar staleness no mesmo burst. Erro/ausência de
 * manifest → `false`: nada a sincronizar via delta; a própria tool reporta o
 * estado honesto (parcial/falha).
 */
export function isManifestStaleForAutoSync(cwd: string): boolean {
  const metadata = readWorkspaceMetadata(cwd);
  if (!metadata) {
    return false;
  }
  let manifest: DiscoveryManifest | null;
  try {
    manifest = readManifest(getManifestPath(metadata.root_path));
  } catch {
    return false;
  }
  if (!manifest) {
    return false;
  }
  const result = computeManifestStaleness(metadata.root_path, manifest, {
    respect_gitignore: resolveRespectGitignore(metadata),
  });
  return result.staleness === "stale";
}

function computeStalenessUncached(
  rootPath: string,
  manifest: DiscoveryManifest,
  options: ComputeStalenessOptions = {},
): StalenessResult {
  try {
    const discovery = discoverFiles(rootPath, {
      respect_gitignore: options.respect_gitignore,
    });
    // Só limitações que comprometem a integridade da comparação geram "unknown".
    // MAX_FILE_SIZE é exclusão determinística e simétrica: o mesmo arquivo grande
    // é omitido na indexação e no recheck (todos usam discoverFiles com o mesmo
    // cap), logo nunca entra no manifest e não introduz incerteza. Tratá-lo como
    // "unknown" zerava staleness — e, por consequência, search — em qualquer repo
    // real com um único arquivo >2MB (lockfile, código gerado, asset).
    // READ_ERROR (não conseguimos ler) e MAX_FILE_COUNT (discovery truncado)
    // sim comprometem a comparação e permanecem "unknown".
    const blockingLimitations = discovery.limitations.filter(
      (limitation) => limitation.code !== "MAX_FILE_SIZE",
    );
    if (blockingLimitations.length > 0) {
      return {
        staleness: "unknown",
        pending_files_count: 0,
      };
    }

    const discoveredMap = new Map(
      discovery.files.map((file) => [file.relative_path, file] as const),
    );
    const manifestMap = new Map(
      manifest.files.map((file) => [file.relative_path, file] as const),
    );

    let pending = 0;

    for (const file of discovery.files) {
      const previous = manifestMap.get(file.relative_path);
      if (!previous) {
        pending += 1;
        continue;
      }
      if (previous.size_bytes !== file.size_bytes || previous.mtime_ms !== file.mtime_ms) {
        pending += 1;
      }
    }

    for (const file of manifest.files) {
      if (!discoveredMap.has(file.relative_path)) {
        pending += 1;
      }
    }

    return {
      staleness: pending > 0 ? "stale" : "fresh",
      pending_files_count: pending,
    };
  } catch {
    return {
      staleness: "unknown",
      pending_files_count: 0,
    };
  }
}
