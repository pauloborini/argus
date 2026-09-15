<!-- Language: **English** · [Português](CONTRIBUTING.pt-BR.md) -->

# Contributing

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/pauloborini/argus.git
cd argus
npm ci
npm run validate
npm run smoke:package
npm run build
npm link --workspace=@owerride/argus
```

For end-user installation, see [README.md](README.md#install).

CLI/MCP surface changes require CLI/MCP tests and README/CHANGELOG updates. Parsing changes require fixtures for the affected language. Do not copy code from incompatible sources; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [project-rules/reference/third_party_reference.md](project-rules/reference/third_party_reference.md).

There are no GitHub Actions release jobs: publishing is local. The release gates and accept criteria live in [project-rules/rules/operational_rules.md](project-rules/rules/operational_rules.md) (section "Distribuicao e versao"); the publish run itself is `node scripts/manual-release.mjs`.
