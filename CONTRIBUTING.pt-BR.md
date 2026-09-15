<!-- Idioma: [English](CONTRIBUTING.md) · **Português** -->

# Contribuindo

Requisitos: Node.js 20+ e npm.

```bash
git clone https://github.com/pauloborini/argus.git
cd argus
npm ci
npm run validate
npm run smoke:package
npm run build
npm link --workspace=@owerride/argus   # CLI global a partir do fonte
```

Usuários finais: `npm install -g @owerride/argus` — veja [README.pt-BR.md → Instalação](README.pt-BR.md#instalação).

Mudanças de surface exigem testes CLI/MCP e atualização do README/CHANGELOG.
Mudanças de parsing exigem fixtures da linguagem afetada. Não copie código de
fontes incompatíveis; consulte [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) e
[project-rules/reference/third_party_reference.md](project-rules/reference/third_party_reference.md).

Release/publish: não há GitHub Actions — os gates e o aceite de publicação estão em
[project-rules/rules/operational_rules.md](project-rules/rules/operational_rules.md) (seção
"Distribuição e versão") e o publish é `node scripts/manual-release.mjs`.
