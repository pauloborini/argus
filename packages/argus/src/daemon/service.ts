import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonLogPath } from "../workspace/user-paths.js";

const LAUNCHD_LABEL = "com.atlascortex.daemon";
const SYSTEMD_UNIT = "argus.service";

export interface ServiceResult {
  ok: boolean;
  message: string;
}

/** Caminho absoluto do CLI compilado (dist/cli.js) a partir deste módulo. */
function resolveCliEntry(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user", SYSTEMD_UNIT);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface ServiceEnv {
  PATH: string;
  HOME: string;
}

/**
 * Captura o ambiente mínimo que o daemon precisa em runtime. launchd e systemd
 * --user partem de um PATH enxuto (`/usr/bin:/bin`); sem isto, ferramentas fora
 * dele — como o `git` do Homebrew em `/opt/homebrew/bin` — somem e o auto-sync
 * (que depende de git) falha silenciosamente. Congelamos o PATH/HOME do shell
 * onde o usuário rodou o install, que tem o ambiente completo.
 */
export function resolveServiceEnv(): ServiceEnv {
  const fallbackPath = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";
  return {
    PATH: process.env.PATH && process.env.PATH.length > 0 ? process.env.PATH : fallbackPath,
    HOME: process.env.HOME || homedir(),
  };
}

export function buildPlist(node: string, cli: string, log: string, env: ServiceEnv): string {
  const args = [node, cli, "daemon"]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(env.PATH)}</string>
    <key>HOME</key>
    <string>${xmlEscape(env.HOME)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

/** Quota um argumento para `ExecStart` do systemd (paths podem ter espaços). */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSystemdUnit(node: string, cli: string, env: ServiceEnv): string {
  const execStart = `${systemdQuote(node)} ${systemdQuote(cli)} daemon`;
  return `[Unit]
Description=Argus auto-sync daemon
After=default.target

[Service]
Type=simple
Environment="PATH=${env.PATH}"
Environment="HOME=${env.HOME}"
ExecStart=${execStart}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/**
 * Instala o daemon como serviço de usuário, com auto-start no login e restart
 * automático. macOS → launchd user agent; Linux → systemd --user. Outras
 * plataformas degradam honesto (instrui rodar `argus daemon` manualmente).
 */
export function installService(): ServiceResult {
  const node = process.execPath;
  const cli = resolveCliEntry();
  const log = daemonLogPath();
  const env = resolveServiceEnv();
  mkdirSync(dirname(log), { recursive: true });

  if (process.platform === "darwin") {
    const plist = launchdPlistPath();
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, buildPlist(node, cli, log, env), "utf-8");
    try {
      // Recarrega de forma idempotente: unload silencioso antes do load -w.
      try {
        execFileSync("launchctl", ["unload", plist], { stdio: "ignore" });
      } catch {
        /* não estava carregado */
      }
      execFileSync("launchctl", ["load", "-w", plist], { stdio: "ignore" });
      return { ok: true, message: `Serviço launchd instalado: ${plist}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Plist escrito mas launchctl falhou: ${message}` };
    }
  }

  if (process.platform === "linux") {
    const unit = systemdUnitPath();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, buildSystemdUnit(node, cli, env), "utf-8");
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
      return { ok: true, message: `Serviço systemd --user instalado: ${unit}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Unit escrita mas systemctl falhou: ${message}` };
    }
  }

  return {
    ok: false,
    message: `Plataforma ${process.platform} sem serviço gerenciado; rode 'argus daemon' manualmente.`,
  };
}

/** Remove o serviço de usuário (idempotente). */
export function uninstallService(): ServiceResult {
  if (process.platform === "darwin") {
    const plist = launchdPlistPath();
    if (existsSync(plist)) {
      try {
        execFileSync("launchctl", ["unload", plist], { stdio: "ignore" });
      } catch {
        /* já descarregado */
      }
      rmSync(plist, { force: true });
    }
    return { ok: true, message: "Serviço launchd removido." };
  }

  if (process.platform === "linux") {
    const unit = systemdUnitPath();
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
    } catch {
      /* já desabilitado */
    }
    if (existsSync(unit)) {
      rmSync(unit, { force: true });
    }
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
    return { ok: true, message: "Serviço systemd --user removido." };
  }

  return { ok: true, message: `Nada a remover na plataforma ${process.platform}.` };
}
