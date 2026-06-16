# Bump de versao e release CI

Runbook para IA executar bump e liberar release sem drift entre codigo, npm e GitHub Actions.

## Objetivo

Gerar uma nova versao publicada em npm, com tag Git, release GitHub, tarball verificavel e docs alinhadas.

## Pre-requisitos

- Branch limpa ou com mudancas conhecidas.
- `gh auth status` autenticado, se for preciso inspecionar Actions/release.
- Secret `NPM_TOKEN` configurado no GitHub repo com token npm Automation valido.
- Workflow `.github/workflows/release.yml` com `permissions.id-token: write`.
- Node suportado pelo projeto (`>=20`); release CI usa Node 24.

## Passo a passo

1. Inspecionar estado real.

```bash
rtk git status --short --branch
rtk git log --oneline -5
rtk npm view atlas-cortex version dist-tags --json
```

2. Escolher a versao nova.

- Patch: correcao pequena, docs de release, CI, bug compat.
- Minor: feature compat.
- Major: quebra de contrato CLI/MCP/API.

3. Atualizar todos os pontos de versao.

Arquivos obrigatorios:

- `package.json`
- `packages/cortex/package.json`
- `packages/cortex/src/version.ts`
- `plugins/atlas-cortex/.codex-plugin/plugin.json`
- `CHANGELOG.md`
- `package-lock.json`

Comando recomendado para lockfile:

```bash
rtk npm install --package-lock-only
```

4. Procurar drift de versao.

```bash
rtk rg -n '"version":|CORTEX_VERSION|atlas-cortex@[0-9]+\.[0-9]+\.[0-9]+' package.json packages plugins README.md README.pt-BR.md COMMANDS.md COMMANDS.pt-BR.md CHANGELOG.md package-lock.json
rtk npm run release:check
```

Regra: exemplos publicos devem usar `atlas-cortex@latest`, exceto quando a doc estiver ensinando pin explicito.

5. Validar codigo e pacote.

```bash
rtk npm run validate
rtk npm run smoke:package
rtk npm pack --workspace=atlas-cortex --dry-run --json
```

Se `smoke:package` falhar localmente por `node-gyp` e path com espaco/parênteses, repetir com cache fora do path problemático:

```bash
rtk env TMPDIR=/tmp npm_config_devdir=/tmp/node-gyp-cache npx -y -p node@24 -p npm@latest npm run smoke:package
```

6. Conferir CI.

CI deve cobrir:

- `npm ci`
- `npm run validate`
- `npm run smoke:package`
- `npm run release:check`
- matriz minima Node 20/22/24, idealmente Ubuntu e macOS.

Release por tag deve cobrir:

- checkout
- setup-node com registry npm
- `npm ci`
- validate
- smoke package
- release check
- `npm publish --workspace=atlas-cortex --access public --provenance`
- GitHub release com assets `dist-release/*`

7. Commitar bump.

```bash
rtk git status --short
rtk git diff --stat
rtk git add package.json package-lock.json packages/cortex/package.json packages/cortex/src/version.ts plugins/atlas-cortex/.codex-plugin/plugin.json CHANGELOG.md README.md README.pt-BR.md COMMANDS.md COMMANDS.pt-BR.md .github/workflows/ci.yml .github/workflows/release.yml docs/RELEASE_BUMP.md .gitignore
rtk git commit -m "chore(release): bump para X.Y.Z"
```

Ajustar lista de arquivos ao diff real. Nao adicionar artefatos gerados como `dist/`, `dist-release/`, `node_modules/` ou `.cortex/`.

8. Criar e enviar tag.

```bash
rtk git tag vX.Y.Z
rtk git push origin HEAD
rtk git push origin vX.Y.Z
```

Se a tag ja existir e apontar para commit errado, parar. Nao sobrescrever sem decisao explicita.

9. Acompanhar release CI.

```bash
rtk gh run list --limit 10 --json databaseId,workflowName,status,conclusion,headBranch,headSha,event,createdAt,displayTitle
rtk gh run view <run-id> --log-failed
```

10. Confirmar publicacao.

```bash
rtk npm view atlas-cortex version dist-tags --json
rtk npm view atlas-cortex@X.Y.Z version dist.integrity --json
rtk npx -y atlas-cortex@X.Y.Z --version
```

11. Confirmar GitHub release.

```bash
rtk gh release view vX.Y.Z --json tagName,isDraft,isPrerelease,assets,url
```

## Checklist de aceite

- `package-lock.json` mostra a versao nova no root e em `packages/cortex`.
- `npm run release:check` passa.
- `npm run validate` passa.
- `smoke:package` passa em ambiente compativel.
- `npm pack --dry-run` gera `atlas-cortex-X.Y.Z.tgz`.
- Tag `vX.Y.Z` aponta para o commit do bump.
- npm registry tem `atlas-cortex@X.Y.Z`.
- `latest` aponta para `X.Y.Z`, exceto release pre-release intencional.
- GitHub release existe e contem tarball + `SHA256SUMS`.

## Falhas comuns

- Lockfile esquecido: `package-lock.json` fica em versao antiga e gera drift.
- README com `atlas-cortex@1.0.0`: usuario instala versao velha.
- `dist-release/` stale: tarball antigo aparece como untracked ou asset errado.
- Tag enviada antes do commit certo: release roda com conteudo antigo.
- `NPM_TOKEN` ausente/expirado: tag existe, mas npm nao publica.
- `node-gyp` falha localmente por path com espaco/parênteses: validar com cache em `/tmp`.

## Regra para IA

Nao declarar release pronto so porque `git tag` existe. Release pronto exige evidencia externa: npm registry com a versao nova e GitHub release concluida.
