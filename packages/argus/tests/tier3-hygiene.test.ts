import { describe, expect, it } from "vitest";
import { buildPlist, buildSystemdUnit, resolveServiceEnv, type ServiceEnv } from "../src/daemon/service.js";
import { watcherExhaustionHint } from "../src/daemon/runtime.js";

const ENV: ServiceEnv = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: "/Users/dev" };

describe("service env explícito (launchd/systemd)", () => {
  it("resolveServiceEnv usa o PATH do shell de install, com fallback", () => {
    const env = resolveServiceEnv();
    expect(env.PATH.length).toBeGreaterThan(0);
    expect(env.HOME.length).toBeGreaterThan(0);
  });

  it("plist injeta EnvironmentVariables com PATH e HOME", () => {
    const plist = buildPlist("/usr/bin/node", "/cli.js", "/log.txt", ENV);
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("/opt/homebrew/bin:/usr/bin:/bin");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("/Users/dev");
  });

  it("systemd unit injeta Environment com PATH e HOME", () => {
    const unit = buildSystemdUnit("/usr/bin/node", "/cli.js", ENV);
    expect(unit).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"');
    expect(unit).toContain('Environment="HOME=/Users/dev"');
  });
});

describe("detecção de exaustão de inotify", () => {
  it("reconhece ENOSPC/EMFILE e dá hint acionável", () => {
    expect(watcherExhaustionHint(new Error("ENOSPC: System limit for number of file watchers reached"))).toMatch(
      /max_user_watches/,
    );
    const emfile = Object.assign(new Error("watch failed"), { code: "EMFILE" });
    expect(watcherExhaustionHint(emfile)).toMatch(/polling/);
  });

  it("erros comuns de backend retornam null (resubscribe normal)", () => {
    expect(watcherExhaustionHint(new Error("backend desconectado"))).toBeNull();
  });
});
