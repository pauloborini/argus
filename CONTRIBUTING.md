# Contribuindo

Requisitos: Node.js 20+ e npm.

```bash
npm ci
npm run validate
npm run smoke:package
```

Mudanças de surface exigem testes CLI/MCP e atualização do README/CHANGELOG.
Mudanças de parsing exigem fixtures da linguagem afetada. Não copie código de
fontes incompatíveis; consulte `.argus/compliance/REUSO_FONTES.md`.
