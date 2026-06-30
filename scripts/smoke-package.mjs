import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(repoRoot, "packages", "argus");
const workDir = mkdtempSync(join(tmpdir(), "argus-smoke-"));
let tarball;

try {
  const packJson = execFileSync("npm", ["pack", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const packed = JSON.parse(packJson);
  tarball = join(packageDir, packed[0].filename);

  execFileSync("npm", ["init", "-y"], { cwd: workDir, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts=false", tarball], {
    cwd: workDir,
    stdio: "inherit",
  });

  const version = execFileSync(
    process.execPath,
    [join(workDir, "node_modules", "argus", "dist", "cli.js"), "--version"],
    { cwd: workDir, encoding: "utf8" },
  ).trim();
  const expected = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
  if (version !== expected) {
    throw new Error(`Smoke version mismatch: ${version} != ${expected}`);
  }

  for (const bin of ["argus"]) {
    const binVersion = execFileSync(join(workDir, "node_modules", ".bin", bin), ["--version"], {
      cwd: workDir,
      encoding: "utf8",
    }).trim();
    if (binVersion !== expected) {
      throw new Error(`Smoke bin ${bin} version mismatch: ${binVersion} != ${expected}`);
    }
  }

  writeFileSync(join(workDir, "sample.ts"), "export function sample() { return 1; }\n");
  const cli = join(workDir, "node_modules", "argus", "dist", "cli.js");
  execFileSync(process.execPath, [cli, "init"], { cwd: workDir, stdio: "inherit" });
  execFileSync(process.execPath, [cli, "index"], { cwd: workDir, stdio: "inherit" });
  execFileSync(process.execPath, [cli, "search", "sample"], {
    cwd: workDir,
    stdio: "inherit",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve", "--mcp"],
    cwd: workDir,
    stderr: "pipe",
  });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => {
    mcpStderr += String(chunk);
  });
  const client = new Client({ name: "argus-package-smoke", version: expected });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length !== 10 || !tools.tools.some((tool) => tool.name === "retrieve")) {
      throw new Error(`Smoke MCP recebeu surface inesperada: ${tools.tools.map((tool) => tool.name)}`);
    }
    const status = await client.callTool({ name: "status", arguments: {} });
    const statusText = status.content.find((item) => item.type === "text");
    if (!statusText || !/"initialized"\s*:\s*true/.test(statusText.text)) {
      throw new Error("Smoke MCP não conseguiu consultar status do workspace.");
    }
  } catch (error) {
    throw new Error(
      `Smoke MCP falhou${mcpStderr.trim() ? `: ${mcpStderr.trim()}` : ""}`,
      { cause: error },
    );
  } finally {
    await client.close();
  }
  console.log(`Smoke do tarball aprovado: argus@${version}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (tarball) {
    try {
      unlinkSync(tarball);
    } catch {
      // Nada a limpar.
    }
  }
}
