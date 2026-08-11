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

CLI/MCP surface changes require CLI/MCP tests and README/CHANGELOG updates. Parsing changes require fixtures for the affected language. Do not copy code from incompatible sources; see `.argus/compliance/REUSO_FONTES.md`.

There are no GitHub Actions release jobs. Follow `docs/MANUAL_RELEASE.md` and `npm run release:manual` for publishing.
