import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(repoRoot, "packages", "argus");
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const packageInstallDir = join("node_modules", ...packageJson.name.split("/"));
const safeTmpRoot = existsSync("/tmp") ? "/tmp" : tmpdir();
const workDir = mkdtempSync(join(safeTmpRoot, "argus-smoke-"));
const nodeGypCache = mkdtempSync(join(safeTmpRoot, "argus-node-gyp-"));
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
    env: { ...process.env, npm_config_devdir: nodeGypCache },
  });

  const version = execFileSync(
    process.execPath,
    [join(workDir, packageInstallDir, "dist", "cli.js"), "--version"],
    { cwd: workDir, encoding: "utf8" },
  ).trim();
  const expected = packageJson.version;
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
  const cli = join(workDir, packageInstallDir, "dist", "cli.js");
  execFileSync(process.execPath, [cli, "init"], { cwd: workDir, stdio: "inherit" });
  execFileSync(process.execPath, [cli, "index"], { cwd: workDir, stdio: "inherit" });
  execFileSync(process.execPath, [cli, "memory", "init"], { cwd: workDir, stdio: "inherit" });
  // Happy path memória: remember → search/recall FTS. Sem memory sync (wipe destrutivo).
  // ARGUS_HOT_EMBED=0 evita baixar modelo no smoke; FTS basta para honestidade do path.
  execFileSync(process.execPath, [cli, "memory", "remember", "# nota\\n"], {
    cwd: workDir,
    stdio: "inherit",
    env: { ...process.env, ARGUS_HOT_EMBED: "0" },
  });
  execFileSync(process.execPath, [cli, "memory", "search", "nota"], { cwd: workDir, stdio: "inherit" });
  execFileSync(process.execPath, [cli, "search", "sample"], {
    cwd: workDir,
    stdio: "inherit",
  });

  // Default slim: ListTools ≤5 (inclui remember). CallTool continua aceitando o catálogo completo.
  const smokeEnv = Object.fromEntries(
    Object.entries({ ...process.env }).filter((entry) => typeof entry[1] === "string"),
  );
  delete smokeEnv.ARGUS_MCP_TOOLS;
  smokeEnv.ARGUS_HOT_EMBED = "0";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve", "--mcp"],
    cwd: workDir,
    stderr: "pipe",
    env: smokeEnv,
  });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => {
    mcpStderr += String(chunk);
  });
  const client = new Client({ name: "argus-package-smoke", version: expected });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const listed = tools.tools.map((tool) => tool.name);
    const expectedListed = ["explore", "pack_context", "recall", "remember", "status"];
    if (
      listed.length !== 5 ||
      expectedListed.some((name, i) => listed[i] !== name)
    ) {
      throw new Error(
        `Smoke MCP esperava ListTools slim na ordem (${expectedListed.join(",")}): got ${listed.join(",")}`,
      );
    }
    // Path feliz listed: remember é discoverável e invocável.
    const remember = await client.callTool({
      name: "remember",
      arguments: { content: "Smoke package remember listed", type: "inbox" },
    });
    const rememberText = remember.content.find((item) => item.type === "text");
    if (!rememberText || /Tool desconhecida|Unknown tool/i.test(rememberText.text ?? "")) {
      throw new Error("Smoke MCP não conseguiu CallTool remember (listed).");
    }
    // Regressão: CallTool das 12 permanece (tool unlisted ≠ desconhecida).
    const search = await client.callTool({
      name: "search",
      arguments: { query: "sample" },
    });
    const searchText = search.content.find((item) => item.type === "text");
    if (!searchText || /Tool desconhecida|Unknown tool/i.test(searchText.text ?? "")) {
      throw new Error("Smoke MCP não conseguiu CallTool search (unlisted).");
    }
    const status = await client.callTool({ name: "status", arguments: {} });
    const statusText = status.content.find((item) => item.type === "text");
    if (!statusText || !/"initialized"\s*:\s*true/.test(statusText.text)) {
      throw new Error("Smoke MCP não conseguiu consultar status do workspace.");
    }
    if (!/"slim"\s*:\s*true/.test(statusText.text)) {
      throw new Error("Smoke MCP status sem mcp_surface.slim=true.");
    }
  } catch (error) {
    throw new Error(
      `Smoke MCP falhou${mcpStderr.trim() ? `: ${mcpStderr.trim()}` : ""}`,
      { cause: error },
    );
  } finally {
    await client.close();
  }
  console.log(`Smoke do tarball aprovado: ${packageJson.name}@${version}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(nodeGypCache, { recursive: true, force: true });
  if (tarball) {
    try {
      unlinkSync(tarball);
    } catch {
      // Nada a limpar.
    }
  }
}
