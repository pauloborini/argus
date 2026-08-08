#!/usr/bin/env node
/**
 * Publicação canônica do @owerride/argus (sem GitHub Actions).
 * Ver docs/MANUAL_RELEASE.md.
 *
 * Uso:
 *   npm run release:manual
 *   node scripts/manual-release.mjs
 *   node scripts/manual-release.mjs --dry-run
 *   node scripts/manual-release.mjs --skip-validate
 *   node scripts/manual-release.mjs --tag v2.3.0
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipValidate = args.has("--skip-validate");
const tagArgIdx = process.argv.indexOf("--tag");
const tagOverride = tagArgIdx >= 0 ? process.argv[tagArgIdx + 1] : null;

/** @type {NodeJS.ProcessEnv} */
let activeEnv = process.env;

function fail(msg) {
  console.error(`manual-release: ${msg}`);
  process.exit(1);
}

function childEnv() {
  const env = {
    ...process.env,
    TMPDIR: process.env.TMPDIR || "/tmp",
    npm_config_cache: process.env.npm_config_cache || "/tmp/npm-cache-argus",
    npm_config_devdir: process.env.npm_config_devdir || "/tmp/node-gyp-cache",
  };

  // Cursor Work e IDEs que isolam HOME: reusa gh/npm do host quando o usuário
  // apontar ARGUS_RELEASE_HOST_HOME para o HOME real do host (opcional).
  // Sem essa var, o script usa apenas o HOME do processo atual.
  const hostHome = process.env.ARGUS_RELEASE_HOST_HOME;
  if (hostHome) {
    if (!env.GH_CONFIG_DIR && !env.GH_TOKEN && !env.GITHUB_TOKEN) {
      const macGh = join(hostHome, ".config/gh");
      if (existsSync(join(macGh, "hosts.yml"))) {
        env.GH_CONFIG_DIR = macGh;
      }
    }
    if (!env.NODE_AUTH_TOKEN && !env.NPM_CONFIG_USERCONFIG) {
      const macNpmrc = join(hostHome, ".npmrc");
      if (existsSync(macNpmrc)) {
        env.NPM_CONFIG_USERCONFIG = macNpmrc;
      }
    }
  }
  return env;
}

function run(cmd, cmdArgs) {
  console.log(`\n→ ${cmd} ${cmdArgs.join(" ")}`);
  const res = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    env: activeEnv,
  });
  if (res.status !== 0) {
    fail(`comando falhou (${cmd}): exit ${res.status}`);
  }
}

function runCapture(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: root,
    encoding: "utf8",
    env: activeEnv,
  });
  if (res.status !== 0) {
    fail(
      `comando falhou (${cmd} ${cmdArgs.join(" ")}): ${(res.stderr || res.stdout || "").trim()}`,
    );
  }
  return (res.stdout || "").trim();
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.version;
}

function preflight(version) {
  console.log("== preflight ==");
  activeEnv = childEnv();

  const ghStatus = spawnSync("gh", ["auth", "status"], {
    cwd: root,
    encoding: "utf8",
    env: activeEnv,
  });
  if (ghStatus.status !== 0 && !activeEnv.GH_TOKEN && !activeEnv.GITHUB_TOKEN) {
    fail(
      "gh não autenticado. Rode `gh auth login` / `gh auth refresh -h github.com` ou exporte GH_TOKEN.",
    );
  }
  console.log("gh: ok");

  const npmWho = spawnSync("npm", ["whoami"], {
    cwd: root,
    encoding: "utf8",
    env: activeEnv,
  });
  const hasNpmAuth = npmWho.status === 0 || Boolean(activeEnv.NODE_AUTH_TOKEN);
  if (!hasNpmAuth && !dryRun) {
    fail("npm não autenticado. Rode `npm login` (conta owerride) ou exporte NODE_AUTH_TOKEN.");
  }
  if (npmWho.status === 0) {
    console.log(`npm whoami: ${npmWho.stdout.trim()}`);
  } else if (activeEnv.NODE_AUTH_TOKEN) {
    console.log("npm: NODE_AUTH_TOKEN presente (whoami pulado)");
  } else {
    console.log("npm: sem auth (ok só em --dry-run)");
  }

  const published = spawnSync("npm", ["view", "@owerride/argus", "version"], {
    cwd: root,
    encoding: "utf8",
    env: activeEnv,
  });
  const publishedVersion = published.status === 0 ? published.stdout.trim() : null;
  console.log(`npm latest atual: ${publishedVersion ?? "(indisponível)"}`);
  console.log(`versão local: ${version}`);

  return { publishedVersion };
}

function ensureDistRelease(version) {
  const dist = join(root, "dist-release");
  if (existsSync(dist)) {
    rmSync(dist, { recursive: true, force: true });
  }
  mkdirSync(dist, { recursive: true });

  run("npm", ["pack", "--workspace=@owerride/argus", "--pack-destination", "dist-release"]);

  const files = readdirSync(dist).filter((f) => f.endsWith(".tgz"));
  if (files.length !== 1) {
    fail(`esperado 1 tarball em dist-release/, achei: ${files.join(", ") || "(nenhum)"}`);
  }
  const expected = `owerride-argus-${version}.tgz`;
  if (files[0] !== expected) {
    fail(`tarball ${files[0]} ≠ esperado ${expected}`);
  }

  const sums = files
    .map((f) => {
      const buf = readFileSync(join(dist, f));
      const hash = createHash("sha256").update(buf).digest("hex");
      return `${hash}  ${f}`;
    })
    .join("\n");
  writeFileSync(join(dist, "SHA256SUMS"), `${sums}\n`);
  console.log(`assets:\n${sums}`);
  return dist;
}

function publishNpm(version, publishedVersion) {
  if (publishedVersion === version) {
    console.log(`npm: @owerride/argus@${version} já publicado — pulando publish`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] npm publish --workspace=@owerride/argus --access public`);
    return;
  }
  run("npm", ["publish", "--workspace=@owerride/argus", "--access", "public"]);
}

function publishGithubRelease(tag, dist) {
  const assets = readdirSync(dist).map((f) => join(dist, f));
  const view = spawnSync("gh", ["release", "view", tag], {
    cwd: root,
    encoding: "utf8",
    env: activeEnv,
  });

  if (dryRun) {
    if (view.status === 0) {
      console.log(`[dry-run] gh release upload ${tag} ${assets.join(" ")} --clobber`);
    } else {
      console.log(
        `[dry-run] gh release create ${tag} ${assets.join(" ")} --generate-notes --verify-tag`,
      );
    }
    return;
  }

  if (view.status === 0) {
    run("gh", ["release", "upload", tag, ...assets, "--clobber"]);
  } else {
    run("gh", ["release", "create", tag, ...assets, "--generate-notes", "--verify-tag"]);
  }
}

function confirm(version, tag) {
  console.log("\n== confirmação ==");
  if (dryRun) {
    console.log("confirmação npm/gh pulada (--dry-run)");
    console.log(`\nmanual-release OK (dry-run): v${version}`);
    return;
  }

  const npmVer = runCapture("npm", ["view", "@owerride/argus", "version"]);
  console.log(`npm view version: ${npmVer}`);
  if (npmVer !== version) {
    fail(`npm ainda em ${npmVer}, esperado ${version}`);
  }

  const releaseJson = runCapture("gh", [
    "release",
    "view",
    tag,
    "--json",
    "tagName,assets,url",
  ]);
  const data = JSON.parse(releaseJson);
  const names = (data.assets || []).map((a) => a.name);
  console.log(`gh release: ${data.url}`);
  console.log(`assets: ${names.join(", ")}`);
  const needTgz = `owerride-argus-${version}.tgz`;
  if (!names.includes(needTgz) || !names.includes("SHA256SUMS")) {
    fail(`release sem assets esperados (precisa ${needTgz} + SHA256SUMS)`);
  }

  console.log(`\nmanual-release OK: v${version}`);
}

function main() {
  process.chdir(root);
  const version = readVersion();
  const tag = tagOverride || `v${version}`;

  if (tag !== `v${version}`) {
    fail(`--tag ${tag} não corresponde a package.json v${version}`);
  }

  // release:check valida tag quando GITHUB_REF_TYPE=tag
  process.env.GITHUB_REF_TYPE = process.env.GITHUB_REF_TYPE || "tag";
  process.env.GITHUB_REF_NAME = process.env.GITHUB_REF_NAME || tag;

  console.log(`manual-release: alvo ${tag}${dryRun ? " (dry-run)" : ""}`);

  const { publishedVersion } = preflight(version);

  run("npm", ["run", "release:check"]);

  if (!skipValidate) {
    run("npm", ["run", "validate"]);
    run("npm", ["run", "smoke:package"]);
  } else {
    console.log("validate/smoke: pulados (--skip-validate)");
  }

  const dist = ensureDistRelease(version);
  publishNpm(version, publishedVersion);
  publishGithubRelease(tag, dist);
  confirm(version, tag);
}

main();
