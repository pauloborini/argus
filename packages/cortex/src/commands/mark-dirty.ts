import { requireWorkspace, resolveRespectGitignore } from "../workspace/workspace.js";
import { gitDelta } from "../discovery/git-delta.js";
import { markDirty } from "../discovery/dirty-flag.js";

export interface MarkDirtyOptions {
  /** Ref git base do evento (ex.: HEAD~1 em post-commit). */
  since?: string;
  cwd?: string;
}

/**
 * Marca o índice como sujo a partir de um evento git. Chamado pelos hooks
 * instalados por `cortex hook install` — barato e não-bloqueante (nunca roda
 * sync). Se o delta git não puder ser resolvido, marca `force_full` para que o
 * próximo sync caia em walk completo (degradação honesta).
 */
export function runMarkDirty(options: MarkDirtyOptions = {}): number {
  const cwd = options.cwd ?? process.cwd();
  let rootPath: string;
  let respectGitignore: boolean;
  try {
    const metadata = requireWorkspace(cwd);
    rootPath = metadata.root_path;
    respectGitignore = resolveRespectGitignore(metadata);
  } catch (err) {
    // Hook em repo sem workspace cortex: silencioso, não trava git.
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  if (!options.since) {
    markDirty([], { cwd, forceFull: true });
    return 0;
  }

  const delta = gitDelta(rootPath, options.since, { respect_gitignore: respectGitignore });
  if (!delta) {
    markDirty([], { cwd, forceFull: true });
    return 0;
  }

  const paths = [...delta.changed.map((file) => file.relative_path), ...delta.removed];
  markDirty(paths, { cwd, sinceRef: options.since });
  return 0;
}
