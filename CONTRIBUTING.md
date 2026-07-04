# Contribuindo

Requisitos: Node.js 20+ e npm.

```bash
git clone https://github.com/pauloborini/argus.git
cd argus
npm ci
npm run validate
npm run smoke:package
npm run build
npm link --workspace=argus   # CLI global a partir do fonte
```

Usuários finais instalam pelo tarball do GitHub Release — veja [README.pt-BR.md → Instalação](README.pt-BR.md#instalação).

Mudanças de surface exigem testes CLI/MCP e atualização do README/CHANGELOG.
Mudanças de parsing exigem fixtures da linguagem afetada. Não copie código de
fontes incompatíveis; consulte `.argus/compliance/REUSO_FONTES.md`.
