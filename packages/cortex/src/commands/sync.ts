import { requireWorkspace } from "../workspace/workspace.js";

export function runSync(): number {
  try {
    requireWorkspace();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  console.error(
    "E_STALE_INDEX: Sincronização incremental indisponível nesta sprint (S03). Implementação prevista em S04+.",
  );
  return 1;
}
