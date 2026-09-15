# GitHub Actions

Workflows de CI/Release foram **removidos de propósito**.

Gates e publicação rodam **localmente**:

- `npm run release:check`
- `npm run validate`
- `npm run smoke:package`
- `node scripts/manual-release.mjs` (publish npm + GitHub Release)

Gates e aceite de publicação: [`project-rules/rules/operational_rules.md`](../project-rules/rules/operational_rules.md) (seção "Distribuição e versão").  
O runbook operacional completo (auth, fluxos A/B, falhas comuns) é local do mantenedor e não vive no repositório.
