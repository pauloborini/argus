import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["README.md", "README.pt-BR.md", 5],
  ["COMMANDS.md", "COMMANDS.pt-BR.md", 5],
  ["CONTRIBUTING.md", "CONTRIBUTING.pt-BR.md", 5],
  ["SECURITY.md", "SECURITY.pt-BR.md", 5],
  ["packages/argus/README.md", "packages/argus/README.pt-BR.md", 80],
];

const fail = (message) => {
  console.error(`Documentation check failed: ${message}`);
  process.exitCode = 1;
};

for (const [english, portuguese, headerLines] of pairs) {
  for (const [file, peer, marker] of [
    [english, portuguese, "Language:"],
    [portuguese, english, "Idioma:"],
  ]) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) {
      fail(`missing ${file}`);
      continue;
    }
    const firstLines = fs.readFileSync(filePath, "utf8").split("\n").slice(0, headerLines).join("\n");
    const peerLink = path.relative(path.dirname(file), peer);
    if (!firstLines.includes(marker) || !firstLines.includes(`](${peerLink})`)) {
      fail(`${file} must link its ${marker === "Language:" ? "Portuguese" : "English"} peer in its first ${headerLines} lines`);
    }
  }
}

if (!process.exitCode) console.log("Public documentation language pairs: OK");
