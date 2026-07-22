# Bump de versao (release local)

Runbook para IA executar bump sem drift entre codigo, npm (`@owerride/argus`) e tarball GitHub Release.

**Publicacao canônica:** [MANUAL_RELEASE.md](MANUAL_RELEASE.md) + `node scripts/manual-release.mjs`  
**Skill:** `.cursor/skills/argus-manual-release/`  
Não há GitHub Actions neste repo.

## Objetivo

Gerar uma nova versao publicada em npm (`@owerride/argus`), com tag Git e release GitHub (`owerride-argus-*.tgz` + `SHA256SUMS`).

## Pre-requisitos

- Branch limpa ou com mudancas conhecidas.
- `gh auth status` autenticado.
- `npm whoami` = `owerride` (ou `NODE_AUTH_TOKEN`).
- Node `>=20`.

## Passo a passo

1. Inspecionar estado real.

```bash
rtk git status --short --branch
rtk git log --oneline -5
rtk npm view @owerride/argus version dist-tags --json
```

2. Escolher a versao nova.

- Patch: correcao pequena, docs de release, bug compat.
- Minor: feature compat.
- Major: quebra de contrato CLI/MCP/API.

3. Atualizar todos os pontos de versao.

Arquivos obrigatorios:

- `package.json`
- `packages/argus/package.json` (`name`: `@owerride/argus`)
- `packages/argus/src/version.ts`
- `plugins/argus/.codex-plugin/plugin.json`
- `plugins/argus/.mcp.json` (`npx -y @owerride/argus serve --mcp`)
- `CHANGELOG.md`
- `package-lock.json`

```bash
rtk npm install --package-lock-only
```

4. Procurar drift de versao.

```bash
rtk rg -n '"version":|ARGUS_VERSION|@owerride/argus' package.json packages plugins README.md README.pt-BR.md COMMANDS.md COMMANDS.pt-BR.md CHANGELOG.md package-lock.json
rtk npm run release:check
```

Regra: install publico e `npm install -g @owerride/argus` (nao `argus` sem escopo).

5. Validar codigo e pacote (gates locais).

```bash
export TMPDIR=/tmp
rtk npm run validate
rtk npm run smoke:package
rtk npm pack --workspace=@owerride/argus --dry-run --json
```

6. Commitar bump, abrir PR `release/vX.Y.Z` → `main`, mergear (1 review; sem checks de Actions).

7. Na `main`: tag `vX.Y.Z`, push, e publicar:

```bash
node scripts/manual-release.mjs
```

8. Confirmar publicacao.

```bash
rtk npm view @owerride/argus version dist-tags --json
rtk npm install -g @owerride/argus@X.Y.Z
rtk argus --version
rtk gh release view vX.Y.Z --json assets
```

## Checklist de aceite

- `npm run release:check` passa.
- npm registry tem `@owerride/argus@X.Y.Z`.
- `npm install -g @owerride/argus` → `argus --version` = `X.Y.Z`.
- GitHub release com `owerride-argus-X.Y.Z.tgz` + `SHA256SUMS`.

## Falhas comuns

- `npm install -g argus` ou `npx argus`: pacote de terceiro no registry.
- npm sem auth: `npm login` (owerride) ou `NODE_AUTH_TOKEN`.
- Lockfile esquecido apos rename de pacote.

## Regra para IA

Release pronto exige `@owerride/argus@X.Y.Z` no npm **e** GitHub release concluida via processo manual.
