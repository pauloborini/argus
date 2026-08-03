import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonRuntime } from "../src/daemon/runtime.js";
import { registerWorkspace, unregisterWorkspace } from "../src/daemon/registry.js";
import {
  DEFAULT_DREAM_SCHEDULE_INTERVAL_MS,
  defaultMemoryConfig,
  resolveDreamSchedule,
  writeMemoryConfig,
} from "../src/memory/config.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { initWorkspace } from "../src/workspace/workspace.js";
import type { ToolResponsePayload } from "../src/mcp/tools/common.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("daemon dream schedule (S07)", () => {
  let tempDir: string | undefined;
  let originalXdgConfig: string | undefined;
  let originalXdgState: string | undefined;
  let runtime: DaemonRuntime | undefined;

  beforeEach(() => {
    originalXdgConfig = process.env.XDG_CONFIG_HOME;
    originalXdgState = process.env.XDG_STATE_HOME;
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop(0);
      runtime = undefined;
    }
    if (tempDir) {
      try {
        unregisterWorkspace(tempDir);
      } catch {
        /* registry may already be gone with temp cleanup */
      }
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    if (originalXdgConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    }
    if (originalXdgState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgState;
    }
  });

  function makeHarness(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-dream-sched-"));
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg-config");
    process.env.XDG_STATE_HOME = join(tempDir, "xdg-state");
    mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
    mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
    const root = join(tempDir, "repo");
    mkdirSync(root, { recursive: true });
    initWorkspace(root);
    registerWorkspace(root);
    return root;
  }

  it("resolveDreamSchedule defaults: enabled, 24h, dry-run", () => {
    expect(resolveDreamSchedule(null)).toEqual({
      enabled: true,
      intervalMs: DEFAULT_DREAM_SCHEDULE_INTERVAL_MS,
      dryRun: true,
    });
    expect(resolveDreamSchedule(undefined).enabled).toBe(true);
    expect(resolveDreamSchedule({ ...defaultMemoryConfig(), dream_schedule_enabled: false }).enabled).toBe(
      false,
    );
    expect(
      resolveDreamSchedule({ ...defaultMemoryConfig(), dream_schedule_interval_ms: 0 }).enabled,
    ).toBe(false);
  });

  it("tick with vault runs dry-run and sets last_dream_ok=true", async () => {
    const root = makeHarness();
    VaultEngine.init(root);
    const cfg = defaultMemoryConfig(root);
    cfg.dream_schedule_interval_ms = 1;
    writeMemoryConfig(cfg, root);

    let calls = 0;
    let lastDryRun: boolean | undefined;
    const dreamRunner = async (
      cwd: string,
      options: { dryRun?: boolean },
    ): Promise<ToolResponsePayload> => {
      calls += 1;
      lastDryRun = options.dryRun;
      expect(cwd).toBe(root);
      return {
        state: "sucesso",
        message: "ok",
        consolidated: 0,
        suggested_actions: [],
        applied_actions: [],
        blocked_actions: [],
        report_file: "reports/dream-report-test.md",
      };
    };

    runtime = new DaemonRuntime({
      dreamTickIntervalMs: 60_000,
      dreamRunner,
      enableWatchers: false,
      exitProcessOnStop: false,
    });
    expect(await runtime.start()).toBe(true);
    await sleep(50);

    const snap = runtime.getStatusSnapshot();
    const ws = snap.workspaces.find((w) => w.root === root);
    expect(ws).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(lastDryRun).toBe(true);
    expect(ws!.last_dream_ok).toBe(true);
    expect(ws!.last_dream_mode).toBe("dry-run");
    expect(ws!.dream_schedule_enabled).toBe(true);
    expect(ws!.last_dream_at).toBeTruthy();
    expect(ws!.last_dream_error).toBeNull();
  });

  it("throw in dream soft-fails without killing runtime", async () => {
    const root = makeHarness();
    VaultEngine.init(root);
    const cfg = defaultMemoryConfig(root);
    cfg.dream_schedule_interval_ms = 1;
    writeMemoryConfig(cfg, root);

    const dreamRunner = async (): Promise<ToolResponsePayload> => {
      throw new Error("boom-dream");
    };

    runtime = new DaemonRuntime({
      dreamTickIntervalMs: 60_000,
      dreamRunner,
      enableWatchers: false,
      exitProcessOnStop: false,
    });
    expect(await runtime.start()).toBe(true);
    await sleep(50);

    const ws = runtime.getStatusSnapshot().workspaces.find((w) => w.root === root);
    expect(ws!.last_dream_ok).toBe(false);
    expect(ws!.last_dream_error).toContain("boom-dream");
    expect(ws!.last_dream_mode).toBe("dry-run");
    // Runtime still usable: second tick remains callable.
    await runtime.tickDreamSchedules();
    expect(runtime.getStatusSnapshot().pid).toBe(process.pid);
  });

  it("no vault skips silently without false error", async () => {
    const root = makeHarness();
    // initWorkspace only — no VaultEngine.init → no vault dir
    const cfg = defaultMemoryConfig(root);
    cfg.dream_schedule_interval_ms = 1;
    writeMemoryConfig(cfg, root);
    expect(existsSync(join(root, ".argus", "memory", "vault"))).toBe(false);

    let calls = 0;
    runtime = new DaemonRuntime({
      dreamTickIntervalMs: 60_000,
      dreamRunner: async () => {
        calls += 1;
        return { state: "sucesso", consolidated: 0 };
      },
      enableWatchers: false,
      exitProcessOnStop: false,
    });
    expect(await runtime.start()).toBe(true);
    await runtime.tickDreamSchedules();

    const ws = runtime.getStatusSnapshot().workspaces.find((w) => w.root === root);
    expect(calls).toBe(0);
    expect(ws!.last_dream_ok).toBeNull();
    expect(ws!.last_dream_error).toBeNull();
    expect(ws!.last_dream_at).toBeNull();
  });

  it("dream_schedule_enabled=false yields zero runs", async () => {
    const root = makeHarness();
    VaultEngine.init(root);
    const cfg = defaultMemoryConfig(root);
    cfg.dream_schedule_enabled = false;
    cfg.dream_schedule_interval_ms = 1;
    writeMemoryConfig(cfg, root);

    let calls = 0;
    runtime = new DaemonRuntime({
      dreamTickIntervalMs: 60_000,
      dreamRunner: async () => {
        calls += 1;
        return { state: "sucesso", consolidated: 0 };
      },
      enableWatchers: false,
      exitProcessOnStop: false,
    });
    expect(await runtime.start()).toBe(true);
    await runtime.tickDreamSchedules();
    await runtime.tickDreamSchedules();

    const ws = runtime.getStatusSnapshot().workspaces.find((w) => w.root === root);
    expect(calls).toBe(0);
    expect(ws!.dream_schedule_enabled).toBe(false);
    expect(ws!.last_dream_ok).toBeNull();
  });
});
