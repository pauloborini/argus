import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverFiles } from "../src/discovery/walk.js";
import { runIndex } from "../src/commands/index-cmd.js";
import { MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { buildToolResponse, buildToolResponseAsync } from "../src/mcp/tools/response.js";
import { createLlmProvider, LlmProviderError } from "../src/memory/llm-provider.js";
import { defaultMemoryConfig, loadMemoryConfig } from "../src/memory/config.js";
import { VaultEngine } from "../src/memory/vault-engine.js";
import { initWorkspace } from "../src/workspace/workspace.js";

const FAKE_SECRET = "ARGUS_FAKE_SECRET_S08_DO_NOT_LOG";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function initGitRepo(cwd: string): void {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

function assertNoSecret(payload: unknown): void {
  expect(JSON.stringify(payload)).not.toContain(FAKE_SECRET);
}

describe("release privacy checklist (S08)", () => {
  let tempDir: string | undefined;
  let originalCwd: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCwd) {
      process.chdir(originalCwd);
      originalCwd = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function setupWorkspace(): string {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "argus-release-privacy-"));
    writeFileSync(join(tempDir, "main.ts"), "export const main = true;\n", "utf-8");
    initWorkspace(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  it("passes local-first privacy checklist for release", async () => {
    const root = setupWorkspace();
    const checklist = {
      gitignored_excluded: false,
      outside_workspace_rejected: false,
      opaque_handles_only: false,
      no_external_llm_without_config: false,
      no_secret_in_outputs: true,
      mcp_twelve_tools: MCP_TOOL_NAMES.length === 12,
    };

    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), `secret.env\n${FAKE_SECRET}\ncache/\n`, "utf-8");
    writeFileSync(join(root, "secret.env"), `TOKEN=${FAKE_SECRET}\n`, "utf-8");
    writeFileSync(join(root, "cache", "out.js"), "noop\n", "utf-8");
    writeFileSync(join(root, "README.md"), "# repo\n", "utf-8");
    initGitRepo(root);
    git(root, ["add", "README.md", "main.ts", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "init"]);

    const indexed = discoverFiles(root, { respect_gitignore: true }).files.map((file) => file.relative_path);
    checklist.gitignored_excluded =
      !indexed.includes("secret.env")
      && !indexed.includes("cache/out.js")
      && indexed.includes("main.ts");

    const outside = mkdtempSync(join(tmpdir(), "argus-outside-"));
    try {
      const outsideStatus = buildToolResponse("status", outside);
      checklist.outside_workspace_rejected =
        outsideStatus.state === "falha"
        && String(outsideStatus.message).includes("E_PATH_OUTSIDE_WORKSPACE");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    expect(await runIndex()).toBe(0);
    VaultEngine.init(root);
    const packed = buildToolResponse("pack_context", root, {
      sources: ["main.ts"],
      goal: "privacy",
      token_budget: 80,
      style: "deep",
    });
    const validHandle = String(packed.retrieve_handle);
    const goodRetrieve = buildToolResponse("retrieve", root, { handle: validHandle });
    const badRetrieve = buildToolResponse("retrieve", root, { handle: "mh_notavalidhandle00" });
    checklist.opaque_handles_only =
      /^rh_[a-f0-9]{16}$/.test(validHandle)
      && ["sucesso", "parcial"].includes(String(goodRetrieve.state))
      && badRetrieve.state === "falha";

    const config = loadMemoryConfig(root) ?? defaultMemoryConfig(root);
    expect(() => createLlmProvider(config)).toThrow(LlmProviderError);
    checklist.no_external_llm_without_config = config.llm_provider === "none";

    const synthesis = await buildToolResponseAsync("pack_context", root, {
      sources: ["main.ts"],
      goal: "privacy synthesis",
      token_budget: 400,
      style: "balanced",
      synthesize: true,
      response_format: "detailed",
    });
    for (const tool of MCP_TOOL_NAMES) {
      // remember exige caminho async (hot embed); demais tools usam dispatcher sync.
      const payload =
        tool === "remember"
          ? await buildToolResponseAsync(tool, root, {
              content: "privacy checklist capture",
              type: "insight",
              response_format: "detailed",
            })
          : buildToolResponse(tool, root, { response_format: "detailed" });
      try {
        assertNoSecret(payload);
      } catch {
        checklist.no_secret_in_outputs = false;
      }
    }
    assertNoSecret(synthesis);
    assertNoSecret(packed);
    assertNoSecret(goodRetrieve);

    expect(checklist).toEqual({
      gitignored_excluded: true,
      outside_workspace_rejected: true,
      opaque_handles_only: true,
      no_external_llm_without_config: true,
      no_secret_in_outputs: true,
      mcp_twelve_tools: true,
    });
  });
});
