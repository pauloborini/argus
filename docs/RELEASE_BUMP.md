# Bump de versao e release CI

Runbook para IA executar bump e liberar release sem drift entre codigo, npm (`@owerride/argus`), tarball GitHub e GitHub Actions.

## Objetivo

Gerar uma nova versao publicada em npm (`@owerride/argus`), com tag Git, release GitHub (`owerride-argus-*.tgz` + `SHA256SUMS`) e docs alinhadas.

## Pre-requisitos

- Branch limpa ou com mudancas conhecidas.
- `gh auth status` autenticado, se for preciso inspecionar Actions/release.
- Secret `NPM_TOKEN` no GitHub (token npm **Automation** da conta `owerride`).
- Node suportado pelo projeto (`>=20`); release CI usa Node 24.

## Passo a passo

1. Inspecionar estado real.

```bash
rtk git status --short --branch
rtk git log --oneline -5
rtk npm view @owerride/argus version dist-tags --json
```

2. Escolher a versao nova.

- Patch: correcao pequena, docs de release, CI, bug compat.
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

Comando recomendado para lockfile:

```bash
rtk npm install --package-lock-only
```

4. Procurar drift de versao.

```bash
rtk rg -n '"version":|ARGUS_VERSION|@owerride/argus' package.json packages plugins README.md README.pt-BR.md COMMANDS.md COMMANDS.pt-BR.md CHANGELOG.md package-lock.json
rtk npm run release:check
```

Regra: install publico e `npm install -g @owerride/argus` (nao `argus` sem escopo).

5. Validar codigo e pacote.

```bash
rtk npm run validate
rtk npm run smoke:package
rtk npm pack --workspace=@owerride/argus --dry-run --json
```

6. Conferir CI.

Release por tag deve cobrir:

- `npm ci`, validate, smoke, release check
- `npm pack --workspace=@owerride/argus` → `dist-release/owerride-argus-X.Y.Z.tgz`
- `npm publish --workspace=@owerride/argus --access public`
- GitHub release com assets `dist-release/*`

7. Commitar bump, criar tag `vX.Y.Z`, push.

8. Acompanhar release CI.

9. Confirmar publicacao.

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
- `NPM_TOKEN` ausente/expirado: npm nao publica, mas GitHub release pode subir.
- Lockfile esquecido apos rename de pacote.

## Regra para IA

Release pronto exige `@owerride/argus@X.Y.Z` no npm **e** GitHub release concluida.
