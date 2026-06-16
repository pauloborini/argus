import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runtime = JSON.parse(
  readFileSync(new URL("../packages/cortex/package.json", import.meta.url), "utf8"),
);
const plugin = JSON.parse(
  readFileSync(new URL("../plugins/atlas-cortex/.codex-plugin/plugin.json", import.meta.url), "utf8"),
);
const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

const lockRootVersion = lockfile.version;
const lockPackageRootVersion = lockfile.packages?.[""]?.version;
const lockRuntimeVersion = lockfile.packages?.["packages/cortex"]?.version;

const versions = new Set([
  root.version,
  runtime.version,
  plugin.version,
  lockRootVersion,
  lockPackageRootVersion,
  lockRuntimeVersion,
]);
if (versions.size !== 1) {
  throw new Error(
    `Versões divergentes: root=${root.version}, runtime=${runtime.version}, plugin=${plugin.version}, lockRoot=${lockRootVersion}, lockPackageRoot=${lockPackageRootVersion}, lockRuntime=${lockRuntimeVersion}`,
  );
}

const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${root.version}`) {
  throw new Error(`Tag ${tag} não corresponde a v${root.version}`);
}

console.log(`Release consistente: v${root.version}`);
