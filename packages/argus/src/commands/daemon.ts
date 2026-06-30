import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  daemonPidPath,
  daemonStatusPath,
} from "../workspace/user-paths.js";
import { runDaemonForeground, type DaemonStatusSnapshot } from "../daemon/runtime.js";
import { installService, uninstallService } from "../daemon/service.js";

function cliEntry(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** PID do daemon vivo, ou `null` (pidfile ausente/morto → limpa o pidfile). */
function runningPid(): number | null {
  const path = daemonPidPath();
  if (!existsSync(path)) {
    return null;
  }
  const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
  if (!Number.isInteger(pid) || !isProcessAlive(pid)) {
    rmSync(path, { force: true });
    return null;
  }
  return pid;
}

/** Roda o daemon em foreground (alvo do serviço launchd/systemd). */
export async function runDaemon(): Promise<number> {
  return (await runDaemonForeground()) ? 0 : 1;
}

/** Sobe o daemon em background (processo destacado). Idempotente. */
export async function runDaemonStart(): Promise<number> {
  const existing = runningPid();
  if (existing !== null) {
    console.log(`Daemon já em execução (pid ${existing}).`);
    return 0;
  }
  const child = spawn(process.execPath, [cliEntry(), "daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const running = runningPid();
    if (running !== null) {
      if (pid !== undefined && running === pid) {
        console.log(`Daemon iniciado (pid ${running}).`);
      } else {
        console.log(`Daemon já em execução (pid ${running}).`);
      }
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.error("Falha ao confirmar daemon iniciado.");
  return 1;
}

/** Para o daemon (SIGTERM). Idempotente. */
export function runDaemonStop(): number {
  const pid = runningPid();
  if (pid === null) {
    console.log("Daemon não está em execução.");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon parado (pid ${pid}).`);
    return 0;
  } catch (err) {
    console.error(`Falha ao parar daemon: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Reinicia o daemon. */
export async function runDaemonRestart(): Promise<number> {
  runDaemonStop();
  // Pequena espera para o pidfile ser removido pelo handler de SIGTERM.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return runDaemonStart();
}

/** Pede ao daemon vivo que recarregue o registry (SIGHUP), sem reiniciar. */
export function runDaemonReload(): number {
  const pid = runningPid();
  if (pid === null) {
    console.log("Daemon não está em execução; nada a recarregar.");
    return 0;
  }
  try {
    process.kill(pid, "SIGHUP");
    console.log(`Registry recarregado no daemon (pid ${pid}).`);
    return 0;
  } catch (err) {
    console.error(`Falha ao recarregar: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Imprime saúde do daemon (pid + último status publicado). */
export function runDaemonStatus(): number {
  const pid = runningPid();
  if (pid === null) {
    console.log("Daemon: parado.");
    return 0;
  }
  console.log(`Daemon: rodando (pid ${pid}).`);
  const statusPath = daemonStatusPath();
  if (!existsSync(statusPath)) {
    console.log("Sem status publicado ainda.");
    return 0;
  }
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf-8")) as DaemonStatusSnapshot;
    console.log(`Iniciado: ${status.started_at}`);
    console.log(`Workspaces observados: ${status.workspaces.length}`);
    for (const ws of status.workspaces) {
      const watch = ws.watching ? "watching" : "OFF";
      const ok =
        ws.last_sync_ok === null ? "?" : ws.last_sync_ok ? "OK" : "ERRO";
      const duration =
        ws.last_sync_duration_ms === null ? "" : `, ${ws.last_sync_duration_ms}ms`;
      const event = ws.last_event_at ? `, último evento ${ws.last_event_at}` : "";
      const backend = ws.watch_backend ? `, backend ${ws.watch_backend}` : "";
      const last = ws.last_sync_at
        ? `último sync ${ws.last_sync_at} (${ws.last_sync_paths} paths, ${ok}${duration}${event}${backend})`
        : `sem sync${backend}`;
      const err = ws.last_error ? ` | erro: ${ws.last_error}` : "";
      console.log(`- ${ws.root} [${watch}] ${last}${err}`);
    }
    return 0;
  } catch {
    console.log("Status ilegível.");
    return 0;
  }
}

/** Instala o serviço de usuário (launchd/systemd) e sobe o daemon. */
export function runDaemonInstallService(): number {
  const result = installService();
  console.log(result.message);
  return result.ok ? 0 : 1;
}

/** Remove o serviço de usuário. */
export function runDaemonUninstallService(): number {
  const result = uninstallService();
  console.log(result.message);
  return result.ok ? 0 : 1;
}

/** True se há daemon vivo (usado pelo install para decidir reload vs start). */
export function isDaemonRunning(): boolean {
  return runningPid() !== null;
}
