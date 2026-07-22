# Release local (canônico)

Publicação de `@owerride/argus` **sem GitHub Actions**. Gates e publish rodam na máquina do mantenedor / agente.

Skill: `.cursor/skills/argus-manual-release/SKILL.md`  
Script: `scripts/manual-release.mjs`  
Bump de arquivos de versão: [RELEASE_BUMP.md](RELEASE_BUMP.md)  
Procedimento patch/minor/major: [PATCH_PROCEDURE.md](PATCH_PROCEDURE.md)

## Por que não há CI

Workflows em `.github/workflows/` foram removidos (cota/billing do Actions). A pasta só guarda um README apontando para este protocolo. Gates locais substituem o antigo `ci.yml` + `release.yml`.

## Aceite

Release só conta como feito quando **todos** passam:

1. `npm run release:check` → `Release consistente: vX.Y.Z`
2. `npm run validate` (typecheck + test + lint + build)
3. `npm run smoke:package`
4. npm registry: `@owerride/argus@X.Y.Z` é `latest` (ou a tag pedida)
5. Tag Git `vX.Y.Z` aponta para o commit publicado na `main`
6. GitHub Release `vX.Y.Z` com `owerride-argus-X.Y.Z.tgz` + `SHA256SUMS`
7. `npm view @owerride/argus version` = `X.Y.Z`

## Pré-requisitos de auth

| Ferramenta | Checagem | Como autenticar |
|---|---|---|
| `gh` | `gh auth status` | `gh auth login` ou `gh auth refresh -h github.com` |
| npm (conta `owerride`) | `npm whoami` → `owerride` | `npm login` **ou** `export NODE_AUTH_TOKEN=<token Automation>`. No Cursor Work, o script reusa `/Users/<voce>/.npmrc` do host via `NPM_CONFIG_USERCONFIG`. |
| git push | `git push` / `gh` | mesmo token/`gh` com escopo `repo` |

Tokens **nunca** vão para o git.

```bash
export GH_TOKEN=ghp_...          # opcional se keyring do gh já funciona
export NODE_AUTH_TOKEN=npm_...   # opcional se `npm login` já gravou ~/.npmrc
```

## Fluxo A — tag já na `main`, só falta publicar

```bash
git fetch origin --tags --prune
git checkout vX.Y.Z

export TMPDIR=/tmp
export npm_config_cache=/tmp/npm-cache-argus
export npm_config_devdir=/tmp/node-gyp-cache

node scripts/manual-release.mjs
```

O script: validate → smoke → release:check → pack → `npm publish` → `gh release create|upload`.

```bash
node scripts/manual-release.mjs --dry-run
node scripts/manual-release.mjs --skip-validate   # se gates já rodaram neste turno
```

## Fluxo B — branch `release/vX.Y.Z` pronta

1. Confirmar bump (`release:check`) e gates locais (`validate` + `smoke:package`).
2. Abrir/atualizar PR `release/vX.Y.Z` → `main`.
3. Mergear na `main` (ainda exige PR + 1 review; **não** há checks de Actions).
4. Na `main` atualizada:

```bash
git checkout main
git pull origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

5. Rodar Fluxo A (`node scripts/manual-release.mjs`).
6. Sync de volta:

```bash
git checkout develop
git pull origin develop
git merge main
git push origin develop
```

## Checklist operacional

```
[ ] gh auth status OK
[ ] npm whoami = owerride (ou NODE_AUTH_TOKEN setado)
[ ] Versão alvo X.Y.Z alinhada (package.json, version.ts, plugin, lockfile)
[ ] npm view @owerride/argus version  ≠ X.Y.Z  (ainda não publicada)
[ ] Branch/tag correta checkoutada
[ ] release:check + validate + smoke OK (ou --skip-validate consciente)
[ ] npm publish concluiu sem E403/ENEEDAUTH
[ ] gh release view vX.Y.Z mostra tarball + SHA256SUMS
[ ] npm view @owerride/argus version = X.Y.Z
[ ] develop sincronizada com main (se Fluxo B)
```

## Falhas comuns

| Sintoma | Ação |
|---|---|
| `gh` token invalid / keyring | `gh auth refresh -h github.com` |
| `npm ENEEDAUTH` / `E403` | Token Automation da conta `owerride` |
| `EPUBLISHCONFLICT` | Versão já no registry — só completar GitHub Release |
| Tag aponta commit errado | Parar. Não `tag -f` sem decisão explícita |
| Smoke falha `node-gyp` / EPERM | `TMPDIR=/tmp` + rodar fora de sandbox (`required_permissions: ["all"]`) |
| Merge bloqueado por “required checks” fantasma | Confirmar que `required_status_checks` da `main` está vazio (Actions removido) |

## Referências

- [scripts/manual-release.mjs](../scripts/manual-release.mjs)
- [scripts/check-release.mjs](../scripts/check-release.mjs)
- [scripts/smoke-package.mjs](../scripts/smoke-package.mjs)
- [.github/workflows/README.md](../.github/workflows/README.md)
