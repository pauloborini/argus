import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runtime = JSON.parse(
  readFileSync(new URL("../packages/cortex/package.json", import.meta.url), "utf8"),
);
const plugin = JSON.parse(
  readFileSync(new URL("../plugins/atlas-cortex/.codex-plugin/plugin.json", import.meta.url), "utf8"),
);
const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

const versionTsSource = readFileSync(
  new URL("../packages/cortex/src/version.ts", import.meta.url),
  "utf8",
);
const cortexVersionMatch = versionTsSource.match(/CORTEX_VERSION\s*=\s*["']([^"']+)["']/);
if (!cortexVersionMatch) {
  throw new Error("Não foi possível extrair CORTEX_VERSION de packages/cortex/src/version.ts");
}
const cortexVersion = cortexVersionMatch[1];

const lockRootVersion = lockfile.version;
const lockPackageRootVersion = lockfile.packages?.[""]?.version;
const lockRuntimeVersion = lockfile.packages?.["packages/cortex"]?.version;

const versions = new Set([
  root.version,
  runtime.version,
  plugin.version,
  cortexVersion,
  lockRootVersion,
  lockPackageRootVersion,
  lockRuntimeVersion,
]);
if (versions.size !== 1) {
  throw new Error(
    `Versões divergentes: root=${root.version}, runtime=${runtime.version}, plugin=${plugin.version}, versionTs=${cortexVersion}, lockRoot=${lockRootVersion}, lockPackageRoot=${lockPackageRootVersion}, lockRuntime=${lockRuntimeVersion}`,
  );
}

// GITHUB_REF_NAME existe em todo evento de Actions (na CI vale o nome da branch,
// ex.: "main"). A checagem de tag só faz sentido quando o ref é realmente uma tag,
// senão a CI por push/PR sempre falharia. GITHUB_REF_TYPE distingue branch x tag.
const refType = process.env.GITHUB_REF_TYPE;
const tag = process.env.GITHUB_REF_NAME;
if (refType === "tag" && tag !== `v${root.version}`) {
  throw new Error(`Tag ${tag} não corresponde a v${root.version}`);
}

console.log(`Release consistente: v${root.version}`);
