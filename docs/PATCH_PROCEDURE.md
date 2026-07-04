# Procedimento de Release (Patch / Minor / Major)

Procedimento completo de ponta a ponta para publicar uma nova versao do `argus` com tag Git, release no GitHub (tarball + checksums) e CI verde.

---

## 1. Pre-requisitos

- [ ] Node.js `>=20` instalado (CI de release usa Node 24)
- [ ] npm `>=10` (gerenciador de dependencias do monorepo)
- [ ] `gh` CLI autenticado (`gh auth status`)
- [ ] Acesso de escrita ao repo GitHub `pauloborini/argus`
- [ ] Secret `NPM_TOKEN` no GitHub (token npm **Automation** da conta `owerride`)
- [ ] Branch `main` protegida exige PR e CI verde antes do merge

---

## 2. Estrategia de branches

```
feature/*  →  develop  →  release/vX.Y.Z  →  main  →  tag vX.Y.Z
                                              ↑
                                         sync de volta
                                              ↓
                                           develop
```

- `develop` — branch de integracao, recebe `feature/*` e `fix/*`
- `release/vX.Y.Z` — branch efemera onde o bump e feito e o PR e aberto contra `main`
- `main` — branch estavel, unica onde **tags sao criadas**
- Tag `vX.Y.Z` na `main` dispara o workflow `.github/workflows/release.yml`

Apos o release, a `main` e mergeada de volta em `develop` para manter o historico sincronizado.

---

## 3. Antes de comecar — verificar estado

```bash
git fetch origin --prune
git checkout develop
git pull origin develop
git log --oneline -10
```

Garanta que `develop` esta atualizada e a CI da ultima push esta verde:

```bash
gh run list --branch develop --limit 5 --json status,conclusion,displayTitle,headBranch
```

---

## 4. Decidir o tipo de bump

| Tipo | Semver | Quando usar |
|---|---|---|
| **Patch** | `1.0.X` → `1.0.Y` | Correcao de bug, docs, ajuste de CI, melhoria interna sem quebra |
| **Minor** | `1.X.0` → `1.Y.0` | Nova feature compativel, nova tool MCP, novo extrator de linguagem |
| **Major** | `X.0.0` → `Y.0.0` | Quebra de contrato CLI/MCP/API, remocao de surface publica |

Verifique a versao atual publicada:

```bash
gh release list --limit 5
# ou, no repo local:
node -p "require('./package.json').version"
```

---

## 5. Criar branch de release

```bash
git checkout develop
git pull origin develop
git checkout -b release/v1.0.2
```

---

## 6. Atualizar todos os pontos de versao

Sao **6 arquivos + lockfile** que precisam ser atualizados com a nova versao:

### 6.1 `package.json` (raiz do monorepo)

```json
"version": "1.0.2"
```

### 6.2 `packages/argus/package.json` (runtime distribuivel)

```json
"name": "@owerride/argus",
"version": "1.0.2",
"publishConfig": { "access": "public" }
```

### 6.3 `packages/argus/src/version.ts`

```typescript
export const ARGUS_VERSION = "1.0.2";
```

### 6.4 `plugins/argus/.codex-plugin/plugin.json`

```json
"version": "1.0.2"
```

### 6.5 `plugins/argus/.mcp.json`

Plugin Codex via npx do pacote com escopo:

```json
"command": "npx",
"args": ["-y", "@owerride/argus", "serve", "--mcp"]
```

Atencao: o `release:check` **nao** valida este arquivo atualmente — confira manualmente.

### 6.6 `CHANGELOG.md`

Adicionar a nova secao no topo:

```markdown
## 1.0.2 - 2026-06-30

- descricao concisa das mudancas desta versao
- cada item comeca com `- ` minusculo, sem ponto final
```

### 6.7 `package-lock.json`

Regenerar o lockfile com a nova versao:

```bash
npm install --package-lock-only
```

---

## 7. Varrer drift de versao residual

```bash
rg -n '"version":|ARGUS_VERSION|argus@[0-9]+\.[0-9]+\.[0-9]+' \
  package.json packages plugins \
  README.md README.pt-BR.md \
  COMMANDS.md COMMANDS.pt-BR.md \
  CHANGELOG.md package-lock.json \
  plugins/argus/.mcp.json
```

Regra: install publico e `npm install -g @owerride/argus` (nao `argus` sem escopo).

---

## 8. Validar localmente

```bash
npm ci
npm run validate          # typecheck + test + lint + build
npm run smoke:package     # instala tarball em dir limpo, testa CLI + MCP
npm run release:check     # verifica 7 fontes de versao identicas
npm pack --workspace=@owerride/argus --dry-run --json
```

Se `smoke:package` falhar localmente por `node-gyp` e path com espaco/parenteses:

```bash
env TMPDIR=/tmp npm_config_devdir=/tmp/node-gyp-cache \
  npx -y -p node@24 -p npm@latest npm run smoke:package
```

Todos os quatro comandos devem passar com **exit code 0**.

---

## 9. Commitar o bump

```bash
git status --short
git diff --stat
```

Adicionar apenas os arquivos alterados do bump:

```bash
git add \
  package.json \
  package-lock.json \
  packages/argus/package.json \
  packages/argus/src/version.ts \
  plugins/argus/.codex-plugin/plugin.json \
  plugins/argus/.mcp.json \
  CHANGELOG.md

git commit -m "chore(release): bump para 1.0.2"
```

Nao adicionar artefatos gerados: `dist/`, `dist-release/`, `node_modules/`, `.argus/`.

---

## 10. Push e abrir PR contra `main`

```bash
git push origin release/v1.0.2
```

Criar PR via GitHub CLI:

```bash
gh pr create \
  --base main \
  --head release/v1.0.2 \
  --title "chore(release): bump para 1.0.2" \
  --body "## Checklist de release

- [ ] \`release:check\` passa
- [ ] \`validate\` passa
- [ ] \`smoke:package\` passa
- [ ] \`npm pack --dry-run\` gera \`argus-1.0.2.tgz\`
- [ ] CHANGELOG atualizado
- [ ] Lockfile sincronizado"
```

Ou abra manualmente em `https://github.com/pauloborini/argus/pull/new/release/v1.0.2` com base `main`.

---

## 11. Revisar o PR

- [ ] CI verde nos jobs `validate` (matriz Node 20/22/24 x Ubuntu/macOS) e `package-smoke`
- [ ] Diff confere: apenas os 7 arquivos esperados alterados
- [ ] `release:check` no log do CI mostra `Release consistente: v1.0.2`
- [ ] Nenhum artefato gerado no diff (`dist/`, `dist-release/`, etc.)
- [ ] CHANGELOG reflete as mudancas reais deste ciclo

---

## 12. Mergear na `main`

```bash
gh pr merge <PR-NUMBER> --merge --delete-branch
```

Ou via botao "Merge pull request" na interface do GitHub — usar **merge commit** (nao squash, nao rebase).

---

## 13. Criar e enviar a tag

A tag DEVE ser criada na `main` apos o merge:

```bash
git checkout main
git pull origin main
```

Conferir que o HEAD e o commit do merge:

```bash
git log --oneline -3
```

Criar e enviar a tag:

```bash
git tag v1.0.2
git push origin v1.0.2
```

Se a tag ja existir e apontar para commit errado, **pare**. Nao sobrescrever (`-f`) sem decisao explicita da equipe. Se necessario:

```bash
git tag -d v1.0.2
git push origin :refs/tags/v1.0.2
# corrigir e repetir
```

---

## 14. Acompanhar o release CI

O push da tag `v*` dispara `.github/workflows/release.yml`.

Acompanhar em tempo real:

```bash
gh run list --limit 5 --json databaseId,workflowName,status,conclusion,headBranch,event,createdAt,displayTitle
```

Ver detalhes de uma run:

```bash
gh run view <run-id>
```

Se falhar, ver logs:

```bash
gh run view <run-id> --log-failed
```

A release CI executa nesta ordem:

1. `npm ci`
2. `npm run validate` (typecheck + test + lint + build)
3. `npm run smoke:package` (tarball em dir limpo, CLI + MCP)
4. `npm run release:check` (7 fontes de versao identicas + tag match)
5. `npm pack` em `dist-release/` com `SHA256SUMS`
6. **`gh release create`** com assets e `--generate-notes`

---

## 15. Confirmar GitHub Release

```bash
gh release view v1.0.2 --json tagName,isDraft,isPrerelease,assets,url
```

Assets esperados:

- `argus-1.0.2.tgz` (tarball instalavel)
- `SHA256SUMS` (checksums SHA-256)

Validar instalacao a partir do asset:

```bash
gh release download v1.0.2 --pattern '*.tgz' -D /tmp
npm install -g /tmp/argus-1.0.2.tgz
argus --version
```

Deve retornar `1.0.2`.

---

## 16. Sync de volta para `develop`

```bash
git checkout develop
git pull origin develop
git merge main
git push origin develop
```

Se houver conflito (raro, pois so o bump foi mergeado na main), resolver manualmente e commitar.

---

## 17. Limpeza pos-release

Remover branches locais/remotas da release:

```bash
git branch -d release/v1.0.2
# a branch remota ja foi deletada pelo --delete-branch no merge do PR
```

Verificar que `dist-release/` nao ficou sujo (e gitignorado):

```bash
git status --short
```

---

## 18. Checklist de aceite final

- [ ] `package.json` (root) = `1.0.2`
- [ ] `packages/argus/package.json` = `1.0.2`
- [ ] `packages/argus/src/version.ts` (`ARGUS_VERSION`) = `"1.0.2"`
- [ ] `plugins/argus/.codex-plugin/plugin.json` = `1.0.2`
- [ ] `plugins/argus/.mcp.json` usa `command: argus`
- [ ] `package-lock.json` root e `packages/argus` = `1.0.2`
- [ ] `npm run release:check` passa
- [ ] `npm run validate` passa
- [ ] `smoke:package` passa
- [ ] Tag `v1.0.2` existe e aponta para o commit do merge na `main`
- [ ] GitHub Release `v1.0.2` existe com tarball + `SHA256SUMS`
- [ ] `npm install -g` a partir do tarball do release retorna `argus --version` = `1.0.2`
- [ ] `develop` sincronizada com `main` (merge de volta feito)

---

## Troubleshooting

### Lockfile esquecido

**Sintoma:** `release:check` falha com `lockRoot` ou `lockRuntime` divergentes.

**Solucao:** Rodar `npm install --package-lock-only` e commitar novamente.

### README com instrucao de install desatualizada

**Sintoma:** Usuario tenta `npm install -g argus` ou `npx argus` e instala pacote de terceiro do registry npm.

**Solucao:** Atualizar README/COMMANDS para instalar via tarball do GitHub Release ou build local.

### Tag enviada antes do merge na main

**Sintoma:** Release CI roda com codigo antigo (conteudo da branch errada).

**Solucao:** Deletar tag remota, fazer checkout correto da `main`, criar tag novamente:

```bash
git push origin :refs/tags/v1.0.2
git checkout main
git pull origin main
git tag v1.0.2
git push origin v1.0.2
```

### `release:check` falha com "Tag main nao corresponde"

**Sintoma:** CI de push/PR falha no `release:check`.

**Solucao:** Verificar se a versao do script `check-release.mjs` inclui a validacao condicional por `GITHUB_REF_TYPE`. A checagem de tag so deve disparar quando `GITHUB_REF_TYPE=tag`. Em `GITHUB_REF_TYPE=branch` (push/PR), a checagem de tag e pulada.

### `node-gyp` falha localmente

**Sintoma:** `smoke:package` falha com erro de compilacao nativa.

**Solucao:** Executar com cache fora do path problematico:

```bash
env TMPDIR=/tmp npm_config_devdir=/tmp/node-gyp-cache \
  npx -y -p node@24 -p npm@latest npm run smoke:package
```

### `version.ts` / `ARGUS_VERSION` esquecido

**Sintoma:** `release:check` detecta drift entre `version.ts` e `package.json`.

**Solucao:** Atualizar `packages/argus/src/version.ts` com a nova versao. O `release:check` valida este campo; o `smoke:package` tambem detecta (CLI retorna versao errada no `--version`).

---

## Referencias

- [RELEASE_BUMP.md](RELEASE_BUMP.md) — runbook para IA executar bump mecanico
- [check-release.mjs](../scripts/check-release.mjs) — script de consistencia de versao
- [smoke-package.mjs](../scripts/smoke-package.mjs) — script de smoke test do tarball
- [release.yml](../.github/workflows/release.yml) — workflow de release por tag
- [ci.yml](../.github/workflows/ci.yml) — workflow de CI (push/PR)
