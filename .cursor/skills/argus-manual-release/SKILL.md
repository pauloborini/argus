---
name: argus-manual-release
description: >-
  Publica release do Argus (@owerride/argus) com gates e publish locais —
  caminho canônico (sem GitHub Actions). Usa scripts/manual-release.mjs e
  docs/MANUAL_RELEASE.md. Acione em bump/patch/minor/major, release na mão,
  publicar npm, criar GitHub Release, tag vX.Y.Z, ou quando o usuário pedir
  para subir versão / release / publish.
---

# Argus — release local (canônico)

## Fonte canônica

1. Este `SKILL.md` (comportamento do agente)
2. [`docs/MANUAL_RELEASE.md`](../../../docs/MANUAL_RELEASE.md)
3. [`scripts/manual-release.mjs`](../../../scripts/manual-release.mjs)
4. Bump de arquivos: [`docs/RELEASE_BUMP.md`](../../../docs/RELEASE_BUMP.md)
5. Procedimento completo: [`docs/PATCH_PROCEDURE.md`](../../../docs/PATCH_PROCEDURE.md)

**Não existe CI/Actions neste repo.** Não espere `ci.yml` / `release.yml`.

## Gatilhos

Acione quando o usuário pedir release, bump, patch, publish, tag, ou “subir versão”.

## Regras duras

- **Não inventar versão.** Ler de `package.json` / `release:check`.
- **Não** `npm publish` se a versão já está no registry (só completar GitHub Release).
- **Não** `git tag -f` / delete de tag remota sem autorização explícita.
- **Não** commitar tokens, `.npmrc` com auth, nem `dist-release/`.
- Gates com `required_permissions: ["all"]` e `TMPDIR=/tmp` (sandbox quebra testes).
- Conversar em **pt-BR**.

## Procedimento

### 0. Diagnóstico

```bash
git status --short --branch
git log --oneline -5
node -p "require('./package.json').version"
npm view @owerride/argus version dist-tags --json
gh auth status
npm whoami
gh release view v$(node -p "require('./package.json').version") --json tagName,assets,url 2>/dev/null || true
git tag -l "v$(node -p "require('./package.json').version")"
```

| Estado | Fluxo |
|---|---|
| Tag + npm + release OK | Nada a publicar; reportar |
| Tag na main, falta npm e/ou release | **Fluxo A** |
| Branch `release/vX.Y.Z`, ainda não na main | **Fluxo B** |
| Auth quebrada | Parar e pedir `gh auth` + `npm login` |

### 1. Auth

```bash
gh auth refresh -h github.com   # se necessário
npm login                       # conta owerride
```

Cursor Work (HOME isolado):

```bash
export NPM_CONFIG_USERCONFIG=/Users/pauloborini/.npmrc
npm whoami   # owerride
```

`scripts/manual-release.mjs` já faz esse fallback.

### 2. Gates locais

```bash
export TMPDIR=/tmp
export npm_config_cache=/tmp/npm-cache-argus
export npm_config_devdir=/tmp/node-gyp-cache
npm run release:check
npm run validate
npm run smoke:package
```

Gate vermelho → corrigir ou abortar. Não publicar.

### 3. Publicar

**Fluxo A** (já em `vX.Y.Z`):

```bash
node scripts/manual-release.mjs
# ou, se gates já rodaram:
node scripts/manual-release.mjs --skip-validate
```

**Fluxo B** (release branch):

1. PR `release/vX.Y.Z` → `main`
2. Merge (1 review; sem checks de Actions)
3. `git tag vX.Y.Z && git push origin vX.Y.Z` na `main`
4. `node scripts/manual-release.mjs`
5. `git checkout develop && git merge main && git push origin develop`

Dry-run: `node scripts/manual-release.mjs --dry-run`

### 4. Aceite

```bash
npm view @owerride/argus version dist-tags --json
gh release view vX.Y.Z --json tagName,assets,url
```

Reportar: versão, URL do Release, sync `develop`, desvios.

## Anti-padrões

- Empurrar tag antes do merge na `main`
- Publicar working tree suja / versão divergente
- Usar `argus` sem escopo (`@owerride/argus` é o pacote)
- Dizer que “CI passou” — o aceite é **validação local** + **publish manual**
