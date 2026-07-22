# GitHub Actions

Workflows de CI/Release foram **removidos de propósito**.

Gates e publicação rodam **localmente**:

- `npm run release:check`
- `npm run validate`
- `npm run smoke:package`
- `node scripts/manual-release.mjs` (publish npm + GitHub Release)

Protocolo: [`docs/MANUAL_RELEASE.md`](../docs/MANUAL_RELEASE.md)  
Skill: `.cursor/skills/argus-manual-release/`
