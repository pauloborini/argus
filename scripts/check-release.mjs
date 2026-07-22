import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runtime = JSON.parse(
  readFileSync(new URL("../packages/argus/package.json", import.meta.url), "utf8"),
);
const plugin = JSON.parse(
  readFileSync(new URL("../plugins/argus/.codex-plugin/plugin.json", import.meta.url), "utf8"),
);
const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

const versionTsSource = readFileSync(
  new URL("../packages/argus/src/version.ts", import.meta.url),
  "utf8",
);
const argusVersionMatch = versionTsSource.match(/ARGUS_VERSION\s*=\s*["']([^"']+)["']/);
if (!argusVersionMatch) {
  throw new Error("Não foi possível extrair ARGUS_VERSION de packages/argus/src/version.ts");
}
const argusVersion = argusVersionMatch[1];

const lockRootVersion = lockfile.version;
const lockPackageRootVersion = lockfile.packages?.[""]?.version;
const lockRuntimeVersion = lockfile.packages?.["packages/argus"]?.version;

const versions = new Set([
  root.version,
  runtime.version,
  plugin.version,
  argusVersion,
  lockRootVersion,
  lockPackageRootVersion,
  lockRuntimeVersion,
]);
if (versions.size !== 1) {
  throw new Error(
    `Versões divergentes: root=${root.version}, runtime=${runtime.version}, plugin=${plugin.version}, versionTs=${argusVersion}, lockRoot=${lockRootVersion}, lockPackageRoot=${lockPackageRootVersion}, lockRuntime=${lockRuntimeVersion}`,
  );
}

// GITHUB_REF_NAME / GITHUB_REF_TYPE: o script manual-release seta
// GITHUB_REF_TYPE=tag ao publicar. Fora disso a checagem de tag é pulada.
const refType = process.env.GITHUB_REF_TYPE;
const tag = process.env.GITHUB_REF_NAME;
if (refType === "tag" && tag !== `v${root.version}`) {
  throw new Error(`Tag ${tag} não corresponde a v${root.version}`);
}

console.log(`Release consistente: v${root.version}`);
