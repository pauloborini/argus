import {
  requireWorkspace,
  resolveRespectGitignore,
} from "../workspace/workspace.js";
import {
  healRootPathIfNeeded,
  W_WORKSPACE_ROOT_HEALED,
} from "../workspace/resolve-workspace.js";
import { gitDelta } from "../discovery/git-delta.js";
import { markDirty } from "../discovery/dirty-flag.js";

export interface MarkDirtyOptions {
  /** Ref git base do evento (ex.: HEAD~1 em post-commit). */
  since?: string;
  /** Start de discovery; I/O de estado usa o root healado. */
  cwd?: string;
}

/**
 * Marca o índice como sujo a partir de um evento git. Chamado pelos hooks
 * instalados por `argus hook install` — barato e não-bloqueante (nunca roda
 * sync). Se o delta git não puder ser resolvido, marca `force_full` para que o
 * próximo sync caia em walk completo (degradação honesta).
 *
 * Dirty-flag é escrita somente sob `rootPath/.argus` (pós-heal), o mesmo root
 * que status/sync leem.
 */
export function runMarkDirty(options: MarkDirtyOptions = {}): number {
  const startCwd = options.cwd ?? process.cwd();
  let rootPath: string;
  let respectGitignore: boolean;
  try {
    const metadata = requireWorkspace(startCwd);
    const { metadata: healedMeta, healed } = healRootPathIfNeeded(startCwd, metadata);
    if (healed) {
      process.stderr.write(
        `${W_WORKSPACE_ROOT_HEALED}: root_path alinhado para ${healedMeta.root_path} (antes: ${metadata.root_path}).\n`,
      );
    }
    rootPath = healedMeta.root_path;
    respectGitignore = resolveRespectGitignore(healedMeta);
  } catch (err) {
    // Hook em repo sem workspace argus: silencioso, não trava git.
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  if (!options.since) {
    markDirty([], { cwd: rootPath, forceFull: true });
    return 0;
  }

  const delta = gitDelta(rootPath, options.since, { respect_gitignore: respectGitignore });
  if (!delta) {
    markDirty([], { cwd: rootPath, forceFull: true });
    return 0;
  }

  const paths = [...delta.changed.map((file) => file.relative_path), ...delta.removed];
  markDirty(paths, { cwd: rootPath, sinceRef: options.since });
  return 0;
}
