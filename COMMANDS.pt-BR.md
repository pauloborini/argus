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

### `cortex install` ⭐ (comando de entrada)
Fiação zero-toque de um repositório, em **um comando**: prepara o workspace,
constrói o índice, escreve as agent-rules (CLAUDE.md/AGENTS.md), registra o
servidor MCP nos hosts detectados (Claude Code, Cursor) e registra o repo no
daemon de auto-sync (com serviço de usuário auto-start). Idempotente.

```bash
cortex install                     # fiação completa
cortex install --no-daemon         # só índice + MCP (sem daemon/serviço)
cortex install --no-mcp            # não registra MCP nos hosts
cortex install --hosts claude-code # restringe os hosts MCP (CSV)
cortex install --with-hooks        # adiciona hooks git como fallback de daemon down
```

Depois disso é só codar — o daemon mantém o índice fresco sozinho.

### `cortex uninstall`
Reverte a fiação do repo: remove o registro de MCP dos hosts, o bloco de
agent-rules, hooks git e o registro no daemon. `--purge` remove também o
`.cortex/`.

```bash
cortex uninstall
cortex uninstall --purge
```

### `cortex init`
Primitivo de baixo nível. Prepara o workspace — cria `.cortex/` no repo alvo
(`workspace.json`, `file-manifest.json`). Idempotente. Para fiação completa
prefira `cortex install`.

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
cortex sync --since HEAD~1   # git-delta: pula o walk completo do filesystem
cortex sync --full           # força walk completo (ignora git-delta/dirty-flag)
```

| Flag | Significado |
|---|---|
| `--since <ref>` | Resolve o delta via `git diff` desde `<ref>`, pulando o walk completo. Cai para walk se não houver git ou o ref for inválido. |
| `--full` | Força walk completo do filesystem, ignorando git-delta e dirty-flag. |

A saída reporta o caminho usado — `via full` · `via git-delta` · `via dirty-flag`
· `via watch` (delta por paths explícitos do daemon) — e, quando uma dirty-flag
foi consumida, o número de paths pendentes.

### `cortex embed`
Gera embeddings semânticos do índice estrutural — **opcional e off-by-default**.
Alimenta a tool `semantic_search`. Modelo bge-small local (baixa no 1º uso,
cache do transformers.js), vetores quantizados int8 no próprio SQLite. **Não
auto-sincroniza**: re-rode após mudanças relevantes (um `cortex index` completo
zera os vetores; `cortex sync` incremental os deixa stale, sinalizado na busca).

```bash
cortex embed
cortex embed --batch 64   # tamanho do lote de inferência (default 32)
```

| Flag | Significado |
|---|---|
| `--batch <n>` | Símbolos por lote de inferência. |

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

### `cortex semantic-search <query>`
Busca por **significado** via embeddings (bge-small local), fundida com o
lexical por RRF. Use quando `search` vier vazio ou a intenção não casar com
nomes literais — ex.: *"limite de watchers do SO esgotado"* acha
`watcherExhaustionHint` mesmo sem o termo no nome. Requer `cortex embed` antes
(off-by-default); sem vetores, degrada honesto (`W_EMBEDDINGS_UNAVAILABLE`) e cai
para resultados lexicais.

```bash
cortex semantic-search "onde tratamos limite de file watchers do SO"
cortex semantic-search "combinar ranking lexical e denso" --mode dense --limit 5
```

| Flag | Significado |
|---|---|
| `--mode <mode>` | `dense` (só vetores) · `hybrid` (fusão RRF com lexical, default). |
| `--scope <path>` | Restringe candidatos a um path/dir. |
| `--kind <kind>` | Restringe por tipo de símbolo. |
| `--limit <n>` | Máximo de candidatos. |

Mesmo shape de candidato do `search`, com `match_reason` ∈ `semantic` ·
`lexical` · `hybrid`. `state` pode vir `stale` (`W_EMBEDDINGS_STALE`) quando o
índice avançou desde o `embed` — resultados servidos com o aviso.

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
cortex serve --mcp --no-auto-sync   # desliga o auto-sync antes das tool calls
```

| Flag | Significado |
|---|---|
| `--mcp` | **Obrigatório.** Inicia o servidor MCP stdio. |
| `--no-auto-sync` | Desliga o sync incremental automático antes de cada tool call. |

Por padrão o servidor consome a dirty-flag e roda um sync incremental antes de
responder, então o agente sempre consulta um índice fresco. Erro de sync nunca
derruba o servidor — o resultado degrada para `parcial` + `staleness_hint`.

Configure seu agente/IDE (veja [README → Usar como servidor MCP](README.pt-BR.md#usar-como-servidor-mcp)).

---

## Daemon de auto-sync

O daemon observa o filesystem (FSEvents/inotify) e mantém o índice fresco em
tempo real, sem nenhum comando manual e independente do editor. Um único daemon
de usuário observa **todos** os repos registrados via `cortex install`. Em
rajadas de saves ou troca de branch os eventos são coalescidos num único sync
incremental (delta por paths, nunca walk completo).

```bash
cortex daemon status     # workspaces observados e último sync de cada um
cortex daemon start      # sobe em background (normalmente o serviço já faz isso)
cortex daemon stop
cortex daemon restart
cortex daemon reload     # recarrega o registry sem reiniciar (após novo install)
```

O `cortex install` já instala e sobe o serviço de usuário (launchd no macOS,
systemd --user no Linux) com auto-start no login. Para gerir o serviço à parte:

```bash
cortex daemon install-service
cortex daemon uninstall-service
```

Se o daemon estiver parado, o índice **não** fica stale: os hooks git opcionais
e o auto-sync preguiçoso do MCP seguem como rede de segurança.

---

## Sync de baixo atrito

Mantenha o índice fresco sem pensar nisso: o daemon sincroniza por evento; como
fallback, hooks git marcam o que mudou e o servidor MCP sincroniza
preguiçosamente antes de responder. Nada trava o commit.

### `cortex hook install` / `cortex hook uninstall`
Instala (ou remove) hooks git (`post-commit`, `post-merge`, `post-checkout`)
que **só marcam o índice como sujo** — nunca rodam sync, então o commit nunca
trava. O caminho do binário fica embutido no script (funciona em clientes git
gráficos e CI). Idempotente; hooks pré-existentes são preservados (cortex
escreve um bloco delimitado).

```bash
cortex hook install
cortex hook uninstall
```

### `cortex agent-rules install` / `cortex agent-rules uninstall`
Escreve (ou remove) um bloco delimitado do Atlas Cortex em `CLAUDE.md` e
`AGENTS.md`, instruindo agentes a usar as tools cortex e confiar no auto-sync.
Apenas append e idempotente — seu conteúdo existente nunca é sobrescrito.

```bash
cortex agent-rules install
cortex agent-rules uninstall
```

### `cortex mark-dirty`
Comando interno chamado pelos hooks instalados. Marca o índice como sujo a
partir de um evento git; se o delta git não puder ser resolvido, marca
`force_full` para o próximo sync cair em walk completo. Normalmente você nunca
chama isso à mão.

```bash
cortex mark-dirty --since HEAD~1
```

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
