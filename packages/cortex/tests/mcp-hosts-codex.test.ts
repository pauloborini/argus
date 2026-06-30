import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

function desiredCliEntry(): string {
  return fileURLToPath(new URL("../src/cli.js", import.meta.url));
}

function codexJson(command: string, args: string[]): string {
  return JSON.stringify({
    name: "atlas-cortex",
    enabled: true,
    transport: {
      type: "stdio",
      command,
      args,
      env: null,
      cwd: null,
    },
  });
}

async function loadMcpHosts() {
  vi.resetModules();
  return await import("../src/install/mcp-hosts.js");
}

describe("mcp-hosts codex adapter", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "which" && args[0] === "codex") {
        return "";
      }
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    });
  });

  it("registra no Codex quando entry não existe", async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "which" && args[0] === "codex") {
        return "";
      }
      if (command === "codex" && args.join(" ") === "mcp get --json atlas-cortex") {
        throw new Error("not found");
      }
      if (command === "codex" && args[0] === "mcp" && args[1] === "add") {
        return "";
      }
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    });

    const { registerMcpForHosts } = await loadMcpHosts();
    const result = registerMcpForHosts("/repo", ["codex"]);

    expect(result[0]).toMatchObject({ ok: true, changed: true });
    expect(result[0].message).toContain("registrado");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codex",
      ["mcp", "add", "atlas-cortex", "--", process.execPath, desiredCliEntry(), "serve", "--mcp"],
      { stdio: "ignore", timeout: 10_000 },
    );
  });

  it("não altera Codex quando entry já bate com o servidor local", async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "which" && args[0] === "codex") {
        return "";
      }
      if (command === "codex" && args.join(" ") === "mcp get --json atlas-cortex") {
        return codexJson(process.execPath, [desiredCliEntry(), "serve", "--mcp"]);
      }
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    });

    const { registerMcpForHosts } = await loadMcpHosts();
    const result = registerMcpForHosts("/repo", ["codex"]);

    expect(result[0]).toMatchObject({ ok: true, changed: false });
    expect(result[0].message).toContain("já registrado");
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining(["add"]),
      expect.anything(),
    );
  });

  it("substitui entry stale do Codex por servidor local absoluto", async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "which" && args[0] === "codex") {
        return "";
      }
      if (command === "codex" && args.join(" ") === "mcp get --json atlas-cortex") {
        return codexJson("npx", ["-y", "atlas-cortex@1.0.0", "serve", "--mcp"]);
      }
      if (command === "codex" && args[0] === "mcp" && (args[1] === "remove" || args[1] === "add")) {
        return "";
      }
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    });

    const { registerMcpForHosts } = await loadMcpHosts();
    const result = registerMcpForHosts("/repo", ["codex"]);

    expect(result[0]).toMatchObject({ ok: true, changed: true });
    expect(result[0].message).toContain("atualizado");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codex",
      ["mcp", "remove", "atlas-cortex"],
      { stdio: "ignore", timeout: 10_000 },
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codex",
      ["mcp", "add", "atlas-cortex", "--", process.execPath, desiredCliEntry(), "serve", "--mcp"],
      { stdio: "ignore", timeout: 10_000 },
    );
  });
});
