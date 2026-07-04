# Bump de versao e release CI

Runbook para IA executar bump e liberar release sem drift entre codigo, tarball GitHub e GitHub Actions.

## Objetivo

Gerar uma nova versao com tag Git, release GitHub (tarball + `SHA256SUMS`), tarball verificavel e docs alinhadas.

## Pre-requisitos

- Branch limpa ou com mudancas conhecidas.
- `gh auth status` autenticado, se for preciso inspecionar Actions/release.
- Node suportado pelo projeto (`>=20`); release CI usa Node 24.

## Passo a passo

1. Inspecionar estado real.

```bash
rtk git status --short --branch
rtk git log --oneline -5
rtk gh release list --limit 5
```

2. Escolher a versao nova.

- Patch: correcao pequena, docs de release, CI, bug compat.
- Minor: feature compat.
- Major: quebra de contrato CLI/MCP/API.

3. Atualizar todos os pontos de versao.

Arquivos obrigatorios:

- `package.json`
- `packages/argus/package.json`
- `packages/argus/src/version.ts`
- `plugins/argus/.codex-plugin/plugin.json`
- `plugins/argus/.mcp.json` (deve usar `command: argus`, nao `npx argus@…`)
- `CHANGELOG.md`
- `package-lock.json`

Comando recomendado para lockfile:

```bash
rtk npm install --package-lock-only
```

4. Procurar drift de versao.

```bash
rtk rg -n '"version":|ARGUS_VERSION|argus@[0-9]+\.[0-9]+\.[0-9]+' package.json packages plugins README.md README.pt-BR.md COMMANDS.md COMMANDS.pt-BR.md CHANGELOG.md package-lock.json
rtk npm run release:check
```

Regra: exemplos publicos devem assumir o binario `argus` no PATH (tarball do GitHub Release ou build local), nao pacote do registry npm.

Nota: `release:check` valida todos os pontos de versao (root, runtime, plugin, `version.ts`/`ARGUS_VERSION`, e as tres entradas do lockfile). A checagem de tag so dispara quando `GITHUB_REF_TYPE=tag`; em push/PR de branch (`GITHUB_REF_TYPE=branch`) o script roda sem exigir match de tag, entao a CI passa normalmente.

5. Validar codigo e pacote.

```bash
rtk npm run validate
rtk npm run smoke:package
rtk npm pack --workspace=argus --dry-run --json
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
- setup-node
- `npm ci`
- validate
- smoke package
- release check
- `npm pack` em `dist-release/` com `SHA256SUMS`
- GitHub release com assets `dist-release/*`

7. Commitar bump.

```bash
rtk git status --short
rtk git diff --stat
rtk git add package.json package-lock.json packages/argus/package.json packages/argus/src/version.ts plugins/argus/.codex-plugin/plugin.json plugins/argus/.mcp.json CHANGELOG.md README.md README.pt-BR.md COMMANDS.md COMMANDS.pt-BR.md .github/workflows/ci.yml .github/workflows/release.yml docs/RELEASE_BUMP.md .gitignore
rtk git commit -m "chore(release): bump para X.Y.Z"
```

Ajustar lista de arquivos ao diff real. Nao adicionar artefatos gerados como `dist/`, `dist-release/`, `node_modules/` ou `.argus/`.

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

10. Confirmar GitHub release e tarball.

```bash
rtk gh release view vX.Y.Z --json tagName,isDraft,isPrerelease,assets,url
rtk gh release download vX.Y.Z --pattern '*.tgz' -D /tmp
rtk npm install -g /tmp/argus-X.Y.Z.tgz
rtk argus --version
rtk argus init --help
```

## Checklist de aceite

- `package-lock.json` mostra a versao nova no root e em `packages/argus`.
- `npm run release:check` passa.
- `npm run validate` passa.
- `smoke:package` passa em ambiente compativel.
- `npm pack --dry-run` gera `argus-X.Y.Z.tgz`.
- Tag `vX.Y.Z` aponta para o commit do bump.
- GitHub release existe e contem tarball + `SHA256SUMS`.
- `npm install -g` a partir do tarball do release retorna `argus --version` = `X.Y.Z`.

## Falhas comuns

- Lockfile esquecido: `package-lock.json` fica em versao antiga e gera drift.
- README com `npm install -g argus` ou `npx argus`: usuario instala pacote de terceiro do registry npm.
- `dist-release/` stale: tarball antigo aparece como untracked ou asset errado.
- Tag enviada antes do commit certo: release roda com conteudo antigo.
- `node-gyp` falha localmente por path com espaco/parênteses: validar com cache em `/tmp`.
- `release:check` falhando na CI com "Tag main não corresponde": versao antiga do script comparava `GITHUB_REF_NAME` (nome da branch) com a tag. Corrigido para so checar quando `GITHUB_REF_TYPE=tag`.
- `version.ts`/`ARGUS_VERSION` esquecido no bump: agora `release:check` pega o drift; antes so o `smoke:package` detectava.

## Regra para IA

Nao declarar release pronto so porque `git tag` existe. Release pronto exige evidencia externa: GitHub release concluida com tarball verificavel e `argus --version` correto apos install do asset.
