<!-- Idioma: [English](COMMANDS.md) · **Português** -->

# Atlas Cortex — Referência de comandos

A lista completa e sem rodeios de comandos. Para *o que é* e *por quê*, leia o
**[README](README.pt-BR.md)**.

Todos os exemplos assumem o binário `cortex` (de `npm install -g atlas-cortex`).
Sem instalação global, prefixe qualquer comando com `npx atlas-cortex …`.

## Convenções

- Toda tool imprime **JSON** no stdout.
- Campos comuns: `state` (`sucesso` · `ambigua` · `parcial` · `stale` ·
  `falha`), `confidence` (`high` · `medium` · `low`) e, quando relevante,
  `limitations[]` e `staleness_hint`.
- O exit code só é diferente de zero quando `state` é `falha`.
- Comandos são scriptáveis: jogue o stdout no `jq` à vontade.

---

## Ciclo de vida

### `cortex init`
Prepara o workspace. Cria `.cortex/` no repo alvo (`workspace.json`,
`file-manifest.json`). Idempotente — reexecutar avisa em vez de falhar.

```bash
cortex init
```

### `cortex index`
Rebuild completo do manifest de arquivos e do índice estrutural SQLite + FTS
(`.cortex/index.db`). Rode uma vez após o `init`, e de novo quando quiser um
rebuild limpo.

```bash
cortex index
```

### `cortex sync`
Atualização incremental — só o delta alterado. Mais barato que `index`. Falha
com `E_INDEX_MISSING` se ainda não houver manifest (rode `cortex index` antes).

```bash
cortex sync
```

### `cortex status`
Saúde e staleness do índice local.

```bash
cortex status
cortex status --path src/billing
```

| Flag | Significado |
|---|---|
| `--path <path>` | Inspecionar um subpath / workspace. |

Saída chave: `staleness` (`fresh` · `stale` · `unknown`), `pending_files_count`,
`coverage_by_language`, `storage_backend`, `schema_version`.

---

## Retrieval

### `cortex search <query>`
Busca lexical + estrutural de símbolos sobre o índice FTS local.

```bash
cortex search "calculateTotal"
cortex search "calculate" --scope src/ --kind function --limit 5
```

| Flag | Significado |
|---|---|
| `--scope <path>` | Restringe candidatos a um path/dir. |
| `--kind <kind>` | Restringe por tipo de símbolo (`function`, `class`, …). |
| `--limit <n>` | Máximo de candidatos. |

Cada candidato: `id`, `kind`, `name`, `path`, `start_line`, `end_line`,
`score`, `match_reason`. `start_line`/`end_line` distinguem símbolos homônimos
no mesmo arquivo e permitem ir direto a eles.

### `cortex files`
Lista a estrutura indexada do workspace.

```bash
cortex files
cortex files --pattern src --max-depth 3
```

| Flag | Significado |
|---|---|
| `--pattern <pattern>` | Filtro por substring no path. |
| `--max-depth <n>` | Profundidade máxima do path. |

Saída: uma `tree` de paths com `symbol_counts`.

### `cortex explore <target>`
Contexto estrutural composto de um símbolo, arquivo ou tema — símbolos
centrais, imports, arquivos relevantes e snippets por faixa de linha de uma vez.
É a tool padrão para "entender esta área".

```bash
cortex explore src/mcp/engine.ts --mode file
cortex explore calculateTotal --mode symbol --depth 2
cortex explore "billing" --mode topic --include-tests
```

| Flag | Significado |
|---|---|
| `--mode <mode>` | `symbol` · `file` · `topic`. |
| `--depth <n>` | Profundidade de exploração (curta). |
| `--include-tests` | Incluir arquivos de teste quando relevante. |
| `--budget <n>` | Budget interno de candidatos. |

### `cortex trace --from <target>`
Fluxo provável entre pontos indexados, com incerteza explícita.

```bash
cortex trace --from calculateTotal
cortex trace --from calculateTotal --to renderInvoice --direction forward --max-hops 4
```

| Flag | Significado |
|---|---|
| `--from <target>` | **Obrigatório.** Símbolo ou arquivo de origem. |
| `--to <target>` | Símbolo ou arquivo de destino. |
| `--direction <dir>` | `forward` · `backward` · `both`. |
| `--max-hops <n>` | Máximo de hops. |

Saída: `paths`, `files`, `symbols`, `uncertainty_points`.

### `cortex impact <target>`
Blast radius provável de mudar um símbolo ou arquivo.

```bash
cortex impact calculateTotal --direction dependents
cortex impact src/billing.ts --depth 2 --include-tests --summary-only
```

| Flag | Significado |
|---|---|
| `--direction <dir>` | `dependents` · `dependencies` · `both`. |
| `--depth <n>` | Profundidade máxima do impacto. |
| `--include-tests` | Incluir arquivos de teste. |
| `--summary-only` | Retornar só agregados / resumo de risco. |

Saída: `direct_affected`, `indirect_affected`, `files`, `tests`,
`risk_summary`.

### `cortex diff-impact`
Impacto provável do diff Git atual — símbolos alterados e testes afetados.

```bash
cortex diff-impact --scope all
cortex diff-impact --scope compare --base-ref main
```

| Flag | Significado |
|---|---|
| `--scope <scope>` | `unstaged` · `staged` · `all` · `compare`. |
| `--base-ref <ref>` | Base Git quando `--scope compare`. |

Saída: `changed_files`, `changed_symbols`, `affected_areas`,
`affected_tests`, `risk_summary`.

---

## Context packing

### `cortex pack-context`
Empacota contexto curto e útil para o modelo. Pode retornar um
`retrieve_handle` quando o budget força truncamento.

```bash
cortex pack-context \
  --sources utils.ts,src/billing.ts \
  --goal "entender o refactor" \
  --token-budget 400 \
  --style balanced
```

| Flag | Significado |
|---|---|
| `--sources <list>` | **Obrigatório.** CSV de paths, símbolos ou handles. |
| `--goal <text>` | **Obrigatório.** Para que serve o pacote. |
| `--token-budget <n>` | **Obrigatório.** Tamanho máximo aprox. do pacote. |
| `--style <style>` | `brief` · `balanced` · `deep`. |

### `cortex retrieve <handle>`
Reidrata o conteúdo original guardado atrás de um `retrieve_handle`. Confinado
ao mesmo workspace; formato do handle é `rh_<16 hex>`.

```bash
cortex retrieve rh_0123456789abcdef
```

---

## Servidor MCP

### `cortex serve --mcp`
Sobe o servidor MCP stdio. Expõe nove tools (`search`, `explore`, `trace`,
`impact`, `diff_impact`, `files`, `pack_context`, `retrieve`, `status`).

```bash
cortex serve --mcp
```

Configure seu agente/IDE (veja [README → Usar como servidor MCP](README.pt-BR.md#usar-como-servidor-mcp)).

---

## Desenvolvimento & release

Rode a partir da raiz do monorepo.

| Comando | Função |
|---|---|
| `npm run build` | Compila `packages/cortex`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Testes unitários (vitest). |
| `npm run lint` | ESLint. |
| `npm run validate` | typecheck + test + lint + build. |
| `npm run benchmark:mvp` | Benchmark interno → `.atlas/benchmark/latest/`. |
| `npm run smoke:package` | Instala e exercita o tarball num diretório limpo. |
| `npm run homologate` | Valida repos externos locais (sonda de retrieval real). |
| `npm run release:check` | Verifica consistência de versão root/runtime/plugin. |

Tags `v*` rodam CI, smoke do tarball, publicação npm com provenance e GitHub
Release com `SHA256SUMS`. A versão da tag deve coincidir com root, runtime e
plugin.

---

## Guia rápido de recuperação

| Sintoma | Correção |
|---|---|
| Índice stale | `cortex sync` |
| Índice ausente/corrompido | apague `.cortex/index.db`, depois `cortex index` |
| Workspace inválido | preserve o código, apague `.cortex/`, depois `cortex init` + `cortex index` |
| Handle corrompido | reempacote com `cortex pack-context` (não edite `.cortex/packed-handles`) |

> Arquivos do projeto nunca são alterados pela recuperação — só o `.cortex/` é tocado.
