import {
  buildDiscoveryManifest,
  fingerprintFile,
} from "../discovery/fingerprint.js";
import {
  ManifestCorruptedError,
  readManifest,
  writeManifestAtomic,
} from "../discovery/manifest.js";
import { discoverFiles } from "../discovery/walk.js";
import type { DiscoveredFile, DiscoveryManifest, FileFingerprint } from "../discovery/types.js";
import { diffManifest, planManifestSync } from "../discovery/delta.js";
import { gitDelta } from "../discovery/git-delta.js";
import { isAbsolute, relative, resolve } from "node:path";
import { buildExplicitDelta } from "../discovery/explicit-delta.js";
import { clearDirtyFlag, markDirty, readDirtyFlag } from "../discovery/dirty-flag.js";
import { normalizeRelativePath } from "../discovery/ignores.js";
import { withSyncLock } from "../concurrency/sync-lock.js";
import type { DiscoveryLimitation } from "../discovery/walk.js";
import {
  buildStructuralIndex,
  updateStructuralIndexDelta,
} from "../extraction/pipeline.js";
import {
  IndexDbCorruptedError,
  IndexDbSchemaError,
  loadStructuralIndexForRead,
  persistFullStructuralIndex,
  persistStructuralIndexDelta,
} from "../storage/index-persistence.js";
import {
  getManifestPath,
  requireWorkspace,
  resolveRespectGitignore,
} from "../workspace/workspace.js";

export type SyncedVia = "full" | "git-delta" | "dirty-flag" | "watch";

export interface SyncOptions {
  /** Ref git base; ativa o caminho de delta git pulando o walk completo. */
  since?: string;
  /** Força walk completo, ignorando git-delta e dirty-flag. */
  full?: boolean;
  /**
   * Conjunto explícito de paths alterados (tipicamente vindo do daemon/watcher).
   * Quando presente, o delta é construído diretamente desses paths — sem walk
   * nem git-delta. Vence `--since`, mas não `--full`.
   */
  paths?: string[];
  /** Override por execução do respeito a `.gitignore` (workspace é o default). */
  respectGitignore?: boolean;
  cwd?: string;
  /** Timeout de aquisição do lock de workspace (ms). Default em `withSyncLock`. */
  lockTimeoutMs?: number;
  /**
   * Suprime a diagnose informativa do stdout. Obrigatório quando invocado
   * programaticamente sob um transporte que possui o stdout (auto-sync do MCP
   * stdio): um `console.log` intercalaria texto não-JSON no stream JSON-RPC.
   * Quando `true`, a diagnose vai para stderr (logs do daemon) em vez do stdout.
   */
  quiet?: boolean;
}

/**
 * Converte paths (abs ou rel) para relativos normalizados ao root, descartando
 * vazios e os que escapam da subárvore do workspace. Usado para registrar na
 * dirty-flag os paths do watcher quando o sync é pulado por contenção de lock.
 */
function toWorkspaceRelative(rootPath: string, paths: string[]): string[] {
  const root = resolve(rootPath);
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw) {
      continue;
    }
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
    const rel = normalizeRelativePath(relative(root, absolute));
    if (rel && !rel.startsWith("../")) {
      out.push(rel);
    }
  }
  return out;
}

interface ResolvedDelta {
  changed: DiscoveredFile[];
  removed: string[];
  limitations: DiscoveryLimitation[];
  syncedVia: SyncedVia;
  dirtyPathsConsumed: number;
}

/**
 * Reaplica um delta (changed/removed) sobre o manifest anterior, produzindo a
 * nova lista de fingerprints. Arquivos não tocados preservam o fingerprint
 * antigo (sem re-hash); só os alterados/adicionados são re-fingerprinted.
 */
function applyDeltaFingerprints(
  previousManifest: DiscoveryManifest,
  changed: DiscoveredFile[],
  removed: string[],
): FileFingerprint[] {
  const byPath = new Map(
    previousManifest.files.map((file) => [file.relative_path, file] as const),
  );
  for (const path of removed) {
    byPath.delete(path);
  }
  for (const file of changed) {
    byPath.set(file.relative_path, fingerprintFile(file));
  }
  return [...byPath.values()];
}

/**
 * Decide a estratégia de detecção de mudança e produz o delta concreto:
 *  - `--full` ou git-delta indisponível → walk completo.
 *  - `--since <ref>` → git-delta.
 *  - sem `--since`, com dirty-flag presente e git-delta resolvível pelo
 *    `since_ref` da flag → git-delta barato; senão walk.
 */
function resolveDelta(
  rootPath: string,
  previousManifest: DiscoveryManifest,
  options: SyncOptions,
  cwd: string,
  respectGitignore: boolean,
): ResolvedDelta {
  const walkPath = (): ResolvedDelta => {
    const discovery = discoverFiles(rootPath, { respect_gitignore: respectGitignore });
    const plan = planManifestSync(previousManifest, discovery.files);
    return {
      changed: [...plan.changed, ...plan.added],
      removed: plan.removed.map((file) => file.relative_path),
      limitations: discovery.limitations,
      syncedVia: "full",
      dirtyPathsConsumed: 0,
    };
  };

  if (options.full) {
    return walkPath();
  }

  // Caminho quente do daemon: delta direto dos paths observados, sem walk nem
  // git-delta. Não depende de git nem de ref — serve edição de working tree.
  if (options.paths && options.paths.length > 0) {
    const explicit = buildExplicitDelta(rootPath, options.paths, {
      respect_gitignore: respectGitignore,
    });
    return {
      changed: explicit.changed,
      removed: explicit.removed,
      limitations: [],
      syncedVia: "watch",
      dirtyPathsConsumed: 0,
    };
  }

  if (options.since) {
    const delta = gitDelta(rootPath, options.since, { respect_gitignore: respectGitignore });
    if (delta) {
      return {
        changed: delta.changed,
        removed: delta.removed,
        limitations: delta.limitations,
        syncedVia: "git-delta",
        dirtyPathsConsumed: 0,
      };
    }
    // Fallback honesto: git ausente ou ref inválido.
    return walkPath();
  }

  const dirty = readDirtyFlag(cwd);
  const dirtyCount = dirty ? dirty.paths.length : 0;
  if (dirty && !dirty.force_full && dirty.paths.length > 0 && dirty.since_ref) {
    const delta = gitDelta(rootPath, dirty.since_ref, { respect_gitignore: respectGitignore });
    if (delta) {
      // Delta veio do consumo da dirty-flag (não de um `--since` explícito):
      // reporta `dirty-flag` como origem honesta do sync.
      return {
        changed: delta.changed,
        removed: delta.removed,
        limitations: delta.limitations,
        syncedVia: "dirty-flag",
        dirtyPathsConsumed: dirty.paths.length,
      };
    }
    // since_ref morto (rebase/gc) ou git ausente: cai no walk, mas a flag ainda
    // foi consumida — propaga o consumo para o sinal honesto não mentir.
  }

  const walked = walkPath();
  walked.dirtyPathsConsumed = dirtyCount;
  return walked;
}

export async function runSync(options: SyncOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  // Diagnose informativa: stdout no uso normal (CLI/daemon), stderr quando
  // `quiet` (caminho MCP, que não pode contaminar o stdout do JSON-RPC).
  const emitInfo = options.quiet
    ? (message: string) => console.error(message)
    : (message: string) => console.log(message);
  let rootPath: string;
  let respectGitignore: boolean;
  try {
    const metadata = requireWorkspace(cwd);
    rootPath = metadata.root_path;
    respectGitignore = resolveRespectGitignore(metadata, options.respectGitignore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  // Seção crítica sob lock de workspace: serializa escritas concorrentes ao
  // índice entre daemon, auto-sync do MCP e `cortex sync` manual. Se o lock não
  // for adquirido a tempo, o sync é pulado (não é erro: outro processo já está
  // reconciliando; o próximo evento/tool-call re-tenta).
  const lock = await withSyncLock(cwd, async (): Promise<number> => {
    const manifestPath = getManifestPath(cwd);
    let previousManifest: DiscoveryManifest | null;
    try {
      previousManifest = readManifest(manifestPath);
    } catch (err) {
      if (err instanceof ManifestCorruptedError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }

    if (!previousManifest) {
      console.error("E_INDEX_MISSING: Índice não inicializado; execute init/index");
      return 1;
    }

    try {
      const resolved = resolveDelta(rootPath, previousManifest, options, cwd, respectGitignore);
      const nextFingerprints = applyDeltaFingerprints(
        previousManifest,
        resolved.changed,
        resolved.removed,
      );
      const delta = diffManifest(previousManifest, nextFingerprints);
      const nextManifest = buildDiscoveryManifest(rootPath, nextFingerprints);
      writeManifestAtomic(manifestPath, nextManifest);

      let previousStructural = null;
      try {
        previousStructural = loadStructuralIndexForRead(rootPath);
      } catch (err) {
        if (err instanceof IndexDbCorruptedError || err instanceof IndexDbSchemaError) {
          console.error(err.message);
          return 1;
        }
        throw err;
      }

      const viaLabel = `via ${resolved.syncedVia}`;

      if (!previousStructural) {
        const { index, summary } = await buildStructuralIndex(nextManifest, rootPath);
        persistFullStructuralIndex(rootPath, index);

        emitInfo(
          `Sync concluído (${viaLabel}): +${delta.added.length} / ~${delta.changed.length} / -${delta.removed.length}.`,
        );
        emitInfo(
          `Extração estrutural (rebuild): ${summary.files_parsed} arquivos, ${summary.symbol_count} símbolos (${summary.duration_ms}ms).`,
        );
      } else if (delta.pending_files_count > 0) {
        const changedPaths = [
          ...delta.added.map((file) => file.relative_path),
          ...delta.changed.map((file) => file.relative_path),
        ];
        const removedPaths = delta.removed.map((file) => file.relative_path);
        const { index, summary } = await updateStructuralIndexDelta(
          nextManifest,
          rootPath,
          previousStructural,
          changedPaths,
          removedPaths,
        );

        const changedSet = new Set(changedPaths);
        persistStructuralIndexDelta(rootPath, {
          manifestHash: index.manifest_hash,
          generatedAt: index.generated_at,
          coverage: index.coverage_by_language,
          extractionLimitations: index.extraction_limitations,
          upsertedFiles: index.files.filter((file) => changedSet.has(file.relative_path)),
          removedPaths,
        });

        emitInfo(
          `Sync concluído (${viaLabel}): +${delta.added.length} / ~${delta.changed.length} / -${delta.removed.length}.`,
        );
        emitInfo(
          `Extração estrutural (delta): ${summary.files_parsed} arquivos reprocessados, ${summary.symbol_count} símbolos (${summary.duration_ms}ms).`,
        );
      } else {
        emitInfo(`Sync concluído (${viaLabel}): índice já estava atualizado (0 alterações).`);
      }

      if (resolved.dirtyPathsConsumed > 0) {
        emitInfo(`Dirty-flag consumida: ${resolved.dirtyPathsConsumed} path(s) pendente(s).`);
      }
      // Limpa a dirty-flag SÓ quando o sync reconciliou o trabalho que ela
      // representa. O caminho `watch` processa apenas os paths explícitos do
      // watcher — não consome a dirty-flag (force_full / since_ref deixados por
      // hooks git ou por um sync pulado). Limpá-la aqui descartaria a rede de
      // segurança e poderia deixar o índice silenciosamente stale com
      // `status: fresh`. Deixá-la intacta faz o próximo sync (MCP lazy / boot /
      // manual) reconciliar de fato.
      if (resolved.syncedVia !== "watch") {
        clearDirtyFlag(cwd);
      }

      if (resolved.limitations.length > 0) {
        console.warn("Sync parcial: limites de discovery atingidos.");
        for (const limitation of resolved.limitations) {
          console.warn(`- ${limitation.code}: ${limitation.path ?? "-"} ${limitation.message}`);
        }
      }

      return 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`E_WORKSPACE_INVALID: Falha durante sincronização: ${message}`);
      return 1;
    }
  }, options.lockTimeoutMs);

  if (!lock.acquired) {
    // Lock ocupado: outro processo já está reconciliando. No caminho do watcher
    // (`paths`), os paths foram tirados do buffer do pipeline e seriam perdidos
    // — registra-os na dirty-flag para que o próximo sync (MCP lazy / boot /
    // manual) reconcilie. Sem isso, uma edição coincidente com a contenção
    // sumiria silenciosamente do índice.
    if (options.paths && options.paths.length > 0) {
      const rel = toWorkspaceRelative(rootPath, options.paths);
      if (rel.length > 0) {
        markDirty(rel, { cwd });
      }
    }
    console.error("Sync já em andamento neste workspace; execução pulada.");
    return 0;
  }
  return lock.result ?? 0;
}
