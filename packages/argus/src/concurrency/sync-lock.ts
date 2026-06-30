import { closeSync, futimesSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getWorkspacePath } from "../workspace/workspace.js";

/** Sleep síncrono curto sem busy-wait (entre tentativas de lock). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_FILE = "sync.lock";
/**
 * Lock considerado órfão após este tempo **sem heartbeat** (mtime do arquivo).
 * O dono vivo refresca o mtime periodicamente ({@link HEARTBEAT_MS}), então um
 * sync longo e saudável nunca cruza este limiar; só um dono morto/travado, que
 * parou de refrescar, envelhece o mtime até aqui.
 */
const STALE_LOCK_MS = 60_000;
/** Intervalo do heartbeat que refresca o mtime do lock enquanto `fn` roda. */
const HEARTBEAT_MS = 20_000;

interface LockRecord {
  pid: number;
  acquired_at: number;
}

function lockPath(cwd: string): string {
  return join(getWorkspacePath(cwd), LOCK_FILE);
}

/** Verdadeiro se o processo `pid` ainda está vivo nesta máquina. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 não envia nada: só testa existência/permissão do processo.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = não existe; EPERM = existe mas sem permissão (logo, vivo).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Idade do arquivo de lock por mtime; `Infinity` se ele sumiu. */
function lockAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** Tenta roubar um lock órfão (dono morto ou velho demais). Best-effort. */
function tryStealStale(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Sumiu entre tentativas: o próximo `openSync wx` decide.
    return;
  }

  let record: LockRecord;
  try {
    record = JSON.parse(raw) as LockRecord;
  } catch {
    // Conteúdo ilegível/vazio. Pode ser a janela entre criar o arquivo
    // (`openSync wx`) e gravar o pid de um dono **vivo** — roubar agora abriria
    // a seção crítica a dois writers. Só rouba se o arquivo for velho o
    // suficiente para não ser uma criação em curso.
    if (lockAgeMs(path) > STALE_LOCK_MS) {
      rmSync(path, { force: true });
    }
    return;
  }

  // Rouba se o dono morreu (recuperação rápida) ou se o heartbeat parou
  // (mtime envelhecido além de STALE_LOCK_MS — dono vivo mas travado, ou pid
  // reciclado). NÃO usa `record.acquired_at`: ele é fixo na aquisição, então um
  // sync longo e saudável pareceria "velho" e teria o lock roubado no meio da
  // escrita → dois escritores → corrupção. O mtime, refrescado pelo heartbeat,
  // distingue "demorado" de "morto".
  if (!isProcessAlive(record.pid) || lockAgeMs(path) > STALE_LOCK_MS) {
    rmSync(path, { force: true });
  }
}

export interface SyncLockResult {
  /** `true` se a seção crítica rodou sob o lock. */
  acquired: boolean;
}

/**
 * Executa `fn` sob um lock de sync por-workspace, serializando escritas
 * concorrentes ao índice entre processos (daemon, auto-sync do MCP e
 * `argus sync` manual). O lock é um arquivo `O_EXCL` com pid+timestamp;
 * locks órfãos (dono morto ou > {@link STALE_LOCK_MS}) são roubados.
 *
 * Se o lock não for adquirido dentro de `timeoutMs`, `fn` **não roda** e o
 * resultado vem com `acquired: false` — o chamador decide (o daemon e o
 * auto-sync simplesmente pulam: o próximo evento re-tenta).
 */
export async function withSyncLock<T>(
  cwd: string,
  fn: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<{ result?: T } & SyncLockResult> {
  const path = lockPath(cwd);
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = openSync(path, "wx");
    } catch {
      if (Date.now() >= deadline) {
        return { acquired: false };
      }
      tryStealStale(path);
      sleepMs(25);
    }
  }

  const lockFd = fd;
  // Heartbeat: refresca o mtime do lock enquanto `fn` roda, sinalizando que o
  // dono está vivo. Sem isto, um sync legítimo mais longo que STALE_LOCK_MS
  // teria o lock roubado por outro processo. `unref` para não segurar o event
  // loop após o término natural do processo.
  const heartbeat = setInterval(() => {
    try {
      const now = Date.now() / 1000;
      futimesSync(lockFd, now, now);
    } catch {
      /* lock removido sob nós (roubo): o finally limpa, a query degrada */
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const record: LockRecord = { pid: process.pid, acquired_at: Date.now() };
    writeSync(fd, JSON.stringify(record));
    const result = await fn();
    return { acquired: true, result };
  } finally {
    clearInterval(heartbeat);
    closeSync(lockFd);
    rmSync(path, { force: true });
  }
}
