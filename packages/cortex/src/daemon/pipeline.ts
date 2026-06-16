import { runSync } from "../commands/sync.js";

export interface PipelineEvents {
  /** Chamado após cada sync disparado pelo pipeline (sucesso ou falha). */
  onSync?: (info: { root: string; paths: number; ok: boolean; durationMs: number }) => void;
  /** Chamado em exceção inesperada de sync (não derruba o pipeline). */
  onError?: (root: string, err: Error) => void;
}

/**
 * Coalesce eventos de FS de um único workspace e dispara sync incremental
 * (delta por paths explícitos) após uma janela de debounce. Garante:
 *  - uma rajada de N saves vira **um** sync, não N (debounce);
 *  - nunca há dois syncs do mesmo workspace concorrentes neste processo (o
 *    `running`/`pending` serializa; o lock cross-process cobre os demais);
 *  - erro de sync nunca derruba o daemon.
 */
export class WorkspacePipeline {
  private readonly buffer = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;

  constructor(
    private readonly root: string,
    private readonly debounceMs: number,
    private readonly events: PipelineEvents = {},
  ) {}

  /** Adiciona paths (absolutos) ao buffer e (re)arma o debounce. */
  enqueue(paths: string[]): void {
    for (const p of paths) {
      this.buffer.add(p);
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.running) {
      // Um sync já está em voo: marca para re-rodar quando ele terminar, sem
      // sobrepor (evita corrida intra-processo sobre o índice).
      this.pending = true;
      return;
    }
    if (this.buffer.size === 0) {
      return;
    }

    const paths = [...this.buffer];
    this.buffer.clear();
    this.running = true;
    const startedAt = Date.now();

    try {
      const code = await runSync({ cwd: this.root, paths });
      this.events.onSync?.({
        root: this.root,
        paths: paths.length,
        ok: code === 0,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      this.events.onError?.(this.root, err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
      // Eventos que chegaram durante o sync (ou um flush adiado): re-processa.
      if (this.pending || this.buffer.size > 0) {
        this.pending = false;
        this.arm();
      }
    }
  }

  /** Força um flush imediato pendente (catch-up de boot). */
  async flushNow(paths: string[]): Promise<void> {
    this.enqueue(paths);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Cancela timers pendentes (shutdown). */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
