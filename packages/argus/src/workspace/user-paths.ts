import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Diretórios de usuário (não por-projeto) do Argus, seguindo XDG quando
 * disponível com fallback para os caminhos clássicos. Hospedam o registry de
 * workspaces observados pelo daemon, o pidfile, o status e o log — estado
 * global do daemon, distinto do `.argus/` por-projeto.
 */

const PRODUCT_SUBDIR = "argus";

export function userConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, PRODUCT_SUBDIR);
}

export function userStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, PRODUCT_SUBDIR);
}

/** Registry de workspaces observados pelo daemon. */
export function registryPath(): string {
  return join(userConfigDir(), "workspaces.json");
}

/** PID do daemon em execução (presença + liveness). */
export function daemonPidPath(): string {
  return join(userStateDir(), "daemon.pid");
}

/** Lock global que garante um único daemon por usuário. */
export function daemonLockPath(): string {
  return join(userStateDir(), "daemon.lock");
}

/** Snapshot de saúde que o daemon escreve periodicamente. */
export function daemonStatusPath(): string {
  return join(userStateDir(), "daemon.json");
}

/** Log estruturado do daemon. */
export function daemonLogPath(): string {
  return join(userStateDir(), "daemon.log");
}
