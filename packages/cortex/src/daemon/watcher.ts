import watcher from "@parcel/watcher";

export type WatchEventType = "create" | "update" | "delete";

export interface WatchBatch {
  /** Paths absolutos criados ou modificados. */
  changed: string[];
  /** Paths absolutos removidos. */
  removed: string[];
}

export interface WorkspaceSubscription {
  unsubscribe(): Promise<void>;
}

/**
 * Diretórios sempre ignorados pelo watcher, independentemente de `.gitignore`.
 * Reduzem ruído e custo de descritores em árvores grandes; o filtro fino por
 * `.gitignore` acontece depois, no `buildExplicitDelta` do sync (um arquivo
 * ignorado que escape daqui ainda não é indexado).
 */
export const DEFAULT_IGNORE: string[] = [
  "**/.git/**",
  "**/.cortex/**",
  "**/node_modules/**",
  "**/.hg/**",
  "**/.svn/**",
];

/**
 * Subscreve um workspace ao backend nativo de FS (FSEvents/inotify/Watchman).
 * Cada lote de eventos é particionado em changed/removed (paths absolutos) e
 * entregue ao `handler`. Erros do backend vão para `onError` — quem decide
 * resubscribe/backoff é o runtime, não o watcher.
 */
export async function subscribeWorkspace(
  root: string,
  handler: (batch: WatchBatch) => void,
  onError: (err: Error) => void,
  ignore: string[] = DEFAULT_IGNORE,
): Promise<WorkspaceSubscription> {
  const subscription = await watcher.subscribe(
    root,
    (err, events) => {
      if (err) {
        onError(err);
        return;
      }
      const changed: string[] = [];
      const removed: string[] = [];
      for (const event of events) {
        if (event.type === "delete") {
          removed.push(event.path);
        } else {
          changed.push(event.path);
        }
      }
      if (changed.length > 0 || removed.length > 0) {
        handler({ changed, removed });
      }
    },
    { ignore },
  );
  return subscription;
}

/**
 * Grava um snapshot do estado atual da árvore, para catch-up posterior via
 * {@link eventsSince} (estilo cursor do Watchman).
 */
export async function writeWatchSnapshot(
  root: string,
  snapshotPath: string,
  ignore: string[] = DEFAULT_IGNORE,
): Promise<void> {
  await watcher.writeSnapshot(root, snapshotPath, { ignore });
}

/**
 * Reconcilia eventos ocorridos desde o último snapshot (ex.: enquanto o daemon
 * esteve down). Retorna o lote particionado; vazio se não houver snapshot ou se
 * o backend não suportar.
 */
export async function eventsSince(
  root: string,
  snapshotPath: string,
  ignore: string[] = DEFAULT_IGNORE,
): Promise<WatchBatch> {
  const events = await watcher.getEventsSince(root, snapshotPath, { ignore });
  const changed: string[] = [];
  const removed: string[] = [];
  for (const event of events) {
    if (event.type === "delete") {
      removed.push(event.path);
    } else {
      changed.push(event.path);
    }
  }
  return { changed, removed };
}
