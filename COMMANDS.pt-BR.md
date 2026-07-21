<!-- Idioma: [English](COMMANDS.md) · **Português** -->

# Argus — Referência de comandos

A lista completa e sem rodeios de comandos. Para *o que é* e *por quê*, leia o
**[README](README.pt-BR.md)**.

Todos os exemplos assumem o binário `argus` no PATH (`npm install -g @owerride/argus`). Veja **[README → Instalação](README.pt-BR.md#instalação)**.

```bash
npm install -g @owerride/argus
```

## Convenções

- Toda tool imprime **JSON** compacto no stdout (friendly para máquina por padrão).
- Campo essencial compartilhado: `state` (`sucesso` · `ambigua` · `parcial` · `stale` · `falha`).
  Erros também incluem `message` com código `E_*` / `W_*`. Os campos `confidence`,
  `limitations[]` e `staleness_hint` (prefixado com código `STALE_*`) aparecem apenas no
  modo `--detailed`.
- O exit code só é diferente de zero quando `state` é `falha`.
- Comandos são scriptáveis: jogue o stdout no `jq` à vontade.

**Flags globais** (funcionam antes de qualquer subcomando):

| Flag | Efeito |
|------|--------|
| `--pretty` | Formata o JSON com indentação para leitura humana (~30–40 % mais tokens) |
| `--detailed` | Envelope completo: `confidence`, `limitations[]`, `staleness_hint` em prosa |

---

## Ciclo de vida

### `argus install` ⭐ (comando de entrada)
Fiação zero-toque de um repositório, em **um comando**: prepara o workspace,
constrói o índice, escreve as agent-rules (CLAUDE.md/AGENTS.md), registra o
servidor MCP nos hosts detectados e registra o repo no daemon de auto-sync (com
serviço de usuário auto-start). Idempotente.

Sem `--hosts`, fia **Claude Code** e **Cursor** sempre (idioma de projeto) e
**auto-detecta** Codex, OpenCode, Pi, Antigravity, ZCode e VS Code quando
instalados nesta máquina (binario no PATH ou diretorio de config presente).

```bash
argus install                     # fiação completa (auto-detecta hosts)
argus install --refresh           # regenera agent-rules + reconverge entradas MCP
argus install --no-daemon         # só índice + MCP (sem daemon/serviço)
argus install --no-mcp            # não registra MCP nos hosts
argus install --no-memory         # não inicializa .argus/memory
argus install --hosts claude-code,codex  # restringe os hosts MCP (CSV)
argus install --global            # registra MCP global (todos os projetos)
argus install --local             # registra MCP só neste repo
argus install --scope global      # equivalente a --global
argus install --scope local       # equivalente a --local
argus install --with-hooks        # adiciona hooks git como fallback de daemon down
```

`--refresh` atualiza só superfícies geradas (bloco Argus versionado em
`AGENTS.md`/`CLAUDE.md` e entradas MCP dos hosts). Conteúdo fora dos marcadores
é preservado byte a byte. Opt-out: `ARGUS_NO_INSTALL_REFRESH=1` (informa a ação
manual). Após o refresh, **reinicie** o processo MCP para o host atualizar o
ListTools.

**Hosts suportados e onde cada um registra o MCP:**

| Host | Mecanismo | Escopo padrão | Config |
|------|-----------|---------------|--------|
| `claude-code` | JSON `mcpServers` | local (repo) | `.mcp.json` |
| `cursor` | JSON `mcpServers` | local (repo) | `.cursor/mcp.json` |
| `codex` | CLI `codex mcp add/remove` | global | `~/.codex/config.toml` (gerido pelo Codex) |
| `opencode` | JSON `mcp`/`type:local` | global | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME`) ou repo |
| `pi` | JSON `mcpServers` | global | `~/.pi/agent/mcp.json` (`PI_CODING_AGENT_DIR`) ou repo |
| `antigravity` | JSON `mcpServers` | global | `~/.gemini/antigravity-ide/mcp_config.json` (`ANTIGRAVITY_CONFIG_DIR`) |
| `zcode` | Plugin filesystem + JSON `mcpServers` | global | `~/.zcode/cli/plugins/cache/argus/<version>/.zcode-plugin/plugin.json` (`ZCODE_CONFIG_HOME`) |
| `vscode` | JSON `mcpServers` | local (repo) | `.vscode/mcp.json` (`VSCODE_CONFIG_HOME`) |

No modo global o MCP é registrado com **caminho absoluto** (não depende do cwd),
valendo em todos os projetos. A config existente é sempre **mesclada** — outros
servers do usuário são preservados. O Codex é fiado pelo próprio CLI (`codex mcp
add`), preservando comentários do `config.toml`; se o `codex` não estiver no
PATH, o host é reportado como "não detectado" sem falha dura.

Depois disso é só codar — o daemon mantém o índice fresco sozinho.

### `argus uninstall`
Reverte a fiação do repo: remove o registro de MCP dos hosts (todos os escopos
por padrão — global + local), o bloco de agent-rules, hooks git e o registro no
daemon. Quando o **ultimo workspace** e desinstalado, o servico de usuario
auto-start (launchd/systemd) tambem e removido. `--purge` remove tambem o
`.argus/`.

Use `--scope` para limitar a limpeza a um unico escopo, `--local`/`--global` como
atalho, ou `--hosts` para hosts especificos.

```bash
argus uninstall                     # reversao completa (todos hosts, todos escopos)
argus uninstall --global            # limpa so o registro MCP global
argus uninstall --local             # limpa so o registro MCP deste repo
argus uninstall --scope global      # equivalente a --global
argus uninstall --hosts codex       # limpa so hosts especificos (CSV)
argus uninstall --hosts opencode --scope global  # limpa so opencode global
argus uninstall --purge             # remove tambem o .argus/
```

### `argus init`
Primitivo de baixo nível. Prepara o workspace — cria `.argus/` no repo alvo
(`workspace.json`, `file-manifest.json`). Idempotente. Para fiação completa
prefira `argus install`.

```bash
argus init
```

### `argus index`
Rebuild completo do manifest de arquivos e do índice estrutural SQLite + FTS
(`.argus/index.db`). Rode uma vez após o `init`, e de novo quando quiser um
rebuild limpo.

```bash
argus index
```

### `argus sync`
Atualização incremental — só o delta alterado. Mais barato que `index`. Falha
com `E_INDEX_MISSING` se ainda não houver manifest (rode `argus index` antes).

```bash
argus sync
argus sync --since HEAD~1   # git-delta: pula o walk completo do filesystem
argus sync --full           # força walk completo (ignora git-delta/dirty-flag)
```

| Flag | Significado |
|---|---|
| `--since <ref>` | Resolve o delta via `git diff` desde `<ref>`, pulando o walk completo. Cai para walk se não houver git ou o ref for inválido. |
| `--full` | Força walk completo do filesystem, ignorando git-delta e dirty-flag. |

A saída reporta o caminho usado — `via full` · `via git-delta` · `via dirty-flag`
· `via watch` (delta por paths explícitos do daemon) — e, quando uma dirty-flag
foi consumida, o número de paths pendentes.

### `argus embed`
Gera embeddings semânticos do índice estrutural — **opcional e off-by-default**.
Alimenta a tool `semantic_search`. Modelo bge-small local (baixa no 1º uso,
cache do transformers.js), vetores quantizados int8 no próprio SQLite. **Não
auto-sincroniza**: re-rode após mudanças relevantes (um `argus index` completo
zera os vetores; `argus sync` incremental os deixa stale, sinalizado na busca).

```bash
argus embed
argus embed --batch 64   # tamanho do lote de inferência (default 32)
```

| Flag | Significado |
|---|---|
| `--batch <n>` | Símbolos por lote de inferência. |

### `argus memory`
Cofre local de conhecimento em `.argus/memory/`.

```bash
argus memory init
printf "# nota\n" | argus memory remember --stdin
argus memory remember "decisão" --type decision --tag s11 --link src/cli.ts
argus memory sync
argus memory embed
argus memory search "nota"
argus memory doctor
argus memory rebuild
argus memory dream
```

A memória usa runtime local-first e embeddings int8 como a busca de código.
Legado `.athena/athena-vault.db` vira apenas backup
`.argus/memory/legacy-athena-vault.db`; runtime novo é `.argus/memory/memory.db`.

### `argus scip import`
Importa edges precisas de um arquivo SCIP — **opcional e off-by-default**.
SCIP (Sourcegraph Code Intelligence Protocol) fornece IDs de símbolo globalmente
estáveis com go-to-def/find-refs precisos. Ao importar, edges SCIP sobrescrevem
as heurísticas tree-sitter para os pares de símbolos cobertos. Requer `argus index`
prévio; re-rode após reindex (reindex zera edges SCIP).

```bash
argus scip import                     # default: <workspace>/index.scip
argus scip import ./build/index.scip  # path explícito
```

| Argumento | Significado |
|---|---|
| `[path]` | Caminho do `index.scip`. Default: `<workspace>/index.scip`. |

Saída: contagem de edges importadas, arquivos casados/ausentes, símbolos cobertos.
SCIP exige um passo de build em CI (`scip-typescript`, `scip-python`, etc.) — o
ganho é condicional ao repo emitir `index.scip`.

### `argus status`
Saúde e staleness do índice local.

```bash
argus status
argus status --path src/billing
```

| Flag | Significado |
|---|---|
| `--path <path>` | Inspecionar um subpath / workspace. |

Saída chave: `staleness` (`fresh` · `stale` · `unknown`), `pending_files_count`,
`coverage_by_language`, `storage_backend`, `schema_version`.

---

## Retrieval

### `argus search <query>`
Busca lexical + estrutural de símbolos sobre o índice FTS local.

```bash
argus search "calculateTotal"
argus search "calculate" --scope src/ --kind function --limit 5
argus search "runSync" --format tsv | cut -f1,2   # TSV ideal para pipes
```

| Flag | Significado |
|---|---|
| `--scope <path>` | Restringe candidatos a um path/dir. |
| `--kind <kind>` | Restringe por tipo de símbolo (`function`, `class`, …). |
| `--limit <n>` | Máximo de candidatos. |
| `--format <fmt>` | `concise` (default) · `detailed` · `tsv` (tab-separated, ideal para pipes). |

Cada candidato: `id`, `kind`, `name`, `path`, `start_line`, `end_line`,
`score`, `match_reason`. `start_line`/`end_line` distinguem símbolos homônimos
no mesmo arquivo e permitem ir direto a eles.

Colunas TSV: `name`, `path`, `kind`, `line`, `score`. Trunca em 50 resultados
(nota vai para stderr); use `--limit` para restringir antes.

### `argus semantic-search <query>`
Busca por **significado** via embeddings (bge-small local), fundida com o
lexical por RRF. Use quando `search` vier vazio ou a intenção não casar com
nomes literais — ex.: *"limite de watchers do SO esgotado"* acha
`watcherExhaustionHint` mesmo sem o termo no nome. Requer `argus embed` antes
(off-by-default); sem vetores, degrada honesto (`W_EMBEDDINGS_UNAVAILABLE`) e cai
para resultados lexicais.

```bash
argus semantic-search "onde tratamos limite de file watchers do SO"
argus semantic-search "combinar ranking lexical e denso" --mode dense --limit 5
```

| Flag | Significado |
|---|---|
| `--mode <mode>` | `dense` (só vetores) · `hybrid` (fusão RRF com lexical, default). |
| `--domain <domain>` | `code` (default) · `memory` · `all`. |
| `--scope <path>` | Restringe candidatos a um path/dir. |
| `--kind <kind>` | Restringe por tipo de símbolo. |
| `--limit <n>` | Máximo de candidatos. |

Mesmo shape de candidato do `search`, com `match_reason` ∈ `semantic` ·
`lexical` · `hybrid`. `state` pode vir `stale` (`W_EMBEDDINGS_STALE`) quando o
índice avançou desde o `embed` — resultados servidos com o aviso.

### `argus files`
Lista a estrutura indexada do workspace.

```bash
argus files
argus files --pattern src --max-depth 3
argus files --format tsv | awk -F'\t' '$3 > 10'   # arquivos com >10 símbolos
```

| Flag | Significado |
|---|---|
| `--pattern <pattern>` | Filtro por substring no path. |
| `--max-depth <n>` | Profundidade máxima do path. |
| `--format <fmt>` | `concise` (default) · `detailed` · `tsv` (tab-separated, ideal para pipes). |

Saída: uma `tree` de paths com `symbol_counts`.

Colunas TSV: `path`, `language`, `symbol_count`. Trunca em 50 resultados
(nota vai para stderr).

### `argus explore <target>`
Contexto estrutural composto de um símbolo, arquivo ou tema — símbolos
centrais, imports, arquivos relevantes e snippets por faixa de linha de uma vez.
É a tool padrão para "entender esta área".

```bash
argus explore src/mcp/engine.ts --mode file
argus explore calculateTotal --mode symbol --depth 2
argus explore "billing" --mode topic --include-tests
```

| Flag | Significado |
|---|---|
| `--mode <mode>` | `symbol` · `file` · `topic`. |
| `--depth <n>` | Profundidade de exploração (curta). |
| `--include-tests` | Incluir arquivos de teste quando relevante. |
| `--budget <n>` | Budget interno de candidatos. |

### `argus trace --from <target>`
Fluxo provável entre pontos indexados, com incerteza explícita.

```bash
argus trace --from calculateTotal
argus trace --from calculateTotal --to renderInvoice --direction forward --max-hops 4
```

| Flag | Significado |
|---|---|
| `--from <target>` | **Obrigatório.** Símbolo ou arquivo de origem. |
| `--to <target>` | Símbolo ou arquivo de destino. |
| `--direction <dir>` | `forward` · `backward` · `both`. |
| `--max-hops <n>` | Máximo de hops. |

Saída: `paths`, `files`, `symbols`, `uncertainty_points`.

### `argus impact <target>`
Blast radius provável de mudar um símbolo ou arquivo.

```bash
argus impact calculateTotal --direction dependents
argus impact src/billing.ts --depth 2 --include-tests --summary-only
```

| Flag | Significado |
|---|---|
| `--direction <dir>` | `dependents` · `dependencies` · `both`. |
| `--depth <n>` | Profundidade máxima do impacto. |
| `--include-tests` | Incluir arquivos de teste. |
| `--summary-only` | Retornar só agregados / resumo de risco. |

Saída: `direct_affected`, `indirect_affected`, `files`, `tests`,
`risk_summary`.

### `argus diff-impact`
Impacto provável do diff Git atual — símbolos alterados e testes afetados.

```bash
argus diff-impact --scope all
argus diff-impact --scope compare --base-ref main
```

| Flag | Significado |
|---|---|
| `--scope <scope>` | `unstaged` · `staged` · `all` · `compare`. |
| `--base-ref <ref>` | Base Git quando `--scope compare`. |

Saída: `changed_files`, `changed_symbols`, `affected_areas`,
`affected_tests`, `risk_summary`.

---

## Context packing

### `argus pack-context`
Empacota contexto curto e útil para o modelo. Pode retornar um
`retrieve_handle` quando o budget força truncamento.

```bash
argus pack-context \
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

### `argus retrieve <handle>`
Reidrata o conteúdo original guardado atrás de um `retrieve_handle`. Confinado
ao mesmo workspace; formato do handle é `rh_<16 hex>`.

```bash
argus retrieve rh_0123456789abcdef
```

---

## Servidor MCP

### `argus serve --mcp`
Sobe o servidor MCP stdio. **ListTools** por default anuncia cinco tools do
path feliz: `explore`, `pack_context`, `recall`, `remember`, `status`. As **doze** tools
registradas (`search`, `explore`, `trace`, `impact`, `diff_impact`, `files`,
`pack_context`, `retrieve`, `status`, `semantic_search`, `remember`, `recall`)
continuam invocáveis via CallTool. Controle a descoberta com `ARGUS_MCP_TOOLS`
(`all` ou CSV); exige restart do MCP após mudança.

```bash
argus serve --mcp
argus serve --mcp --no-auto-sync   # desliga o auto-sync antes das tool calls
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
de usuário observa **todos** os repos registrados via `argus install`. Em
rajadas de saves ou troca de branch os eventos são coalescidos num único sync
incremental (delta por paths, nunca walk completo).

```bash
argus daemon status     # workspaces observados e último sync de cada um
argus daemon start      # sobe em background (normalmente o serviço já faz isso)
argus daemon stop
argus daemon restart
argus daemon reload     # recarrega o registry sem reiniciar (após novo install)
```

O `argus install` já instala e sobe o serviço de usuário (launchd no macOS,
systemd --user no Linux) com auto-start no login. Para gerir o serviço à parte:

```bash
argus daemon install-service
argus daemon uninstall-service
```

Quando o **último workspace** é desinstalado (`argus uninstall`), o serviço de
usuário é removido automaticamente — sem limpeza manual necessária.

Se o daemon estiver parado, o índice **não** fica stale: os hooks git opcionais
e o auto-sync preguiçoso do MCP seguem como rede de segurança.

---

## Sync de baixo atrito

Mantenha o índice fresco sem pensar nisso: o daemon sincroniza por evento; como
fallback, hooks git marcam o que mudou e o servidor MCP sincroniza
preguiçosamente antes de responder. Nada trava o commit.

### `argus hook install` / `argus hook uninstall`
Instala (ou remove) hooks git (`post-commit`, `post-merge`, `post-checkout`)
que **só marcam o índice como sujo** — nunca rodam sync, então o commit nunca
trava. O caminho do binário fica embutido no script (funciona em clientes git
gráficos e CI). Idempotente; hooks pré-existentes são preservados (argus
escreve um bloco delimitado).

```bash
argus hook install
argus hook uninstall
```

### `argus agent-rules install` / `argus agent-rules uninstall`
Escreve (ou remove) um bloco delimitado do Argus em `CLAUDE.md` e
`AGENTS.md`, instruindo agentes a usar as tools argus e confiar no auto-sync.
Apenas append e idempotente — seu conteúdo existente nunca é sobrescrito.

```bash
argus agent-rules install
argus agent-rules uninstall
```

### `argus mark-dirty`
Comando interno chamado pelos hooks instalados. Marca o índice como sujo a
partir de um evento git; se o delta git não puder ser resolvido, marca
`force_full` para o próximo sync cair em walk completo. Normalmente você nunca
chama isso à mão.

```bash
argus mark-dirty --since HEAD~1
```

---

## Desenvolvimento & release

Rode a partir da raiz do monorepo.

| Comando | Função |
|---|---|
| `npm run build` | Compila `packages/argus`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Testes unitários (vitest). |
| `npm run lint` | ESLint. |
| `npm run validate` | typecheck + test + lint + build. |
| `npm run benchmark:mvp` | Benchmark interno → `.argus/benchmark/latest/`. |
| `npm run smoke:package` | Instala e exercita o tarball num diretório limpo. |
| `npm run homologate` | Sonda CLI em ≥2 corpora (fixtures por default) + S8 agent-facing MCP. |
| `npm run release:check` | Verifica consistência de versão root/runtime/plugin. |
| `npm run release:eval` | Evidência agregada memória/privacidade/performance com veredito bloqueante → `.argus/release-evaluation/latest.json`. |

Homologação usa por default os fixtures `corpus-small` + `corpus-medium`.
Override: `ARGUS_HOMOLOGATION_REPOS=repoA:repoB`. A prova agent-facing (S8)
roda MCP in-process nesses corpora e faz replay do golden `homologate-agent-v1`.

Avaliação de release cobre retrieval/memória agregados, privacidade local-first, degradação sem embeddings/LLM, dream dry-run e superfície MCP (ListTools slim por default; CallTool mantém as 12, inclusive `remember`/`recall`). Performance registrada é orientativa, sem SLA. Veredito diferente de `passed` sai com código não-zero.

Tags `v*` rodam CI, smoke do tarball, publicação npm (`@owerride/argus`) e GitHub Release com `SHA256SUMS`. A versão da tag deve coincidir com root, runtime e plugin.

---

## Guia rápido de recuperação

| Sintoma | Correção |
|---|---|
| Índice stale | `argus sync` |
| Índice ausente/corrompido | apague `.argus/index.db`, depois `argus index` |
| Workspace inválido | preserve o código, apague `.argus/`, depois `argus init` + `argus index` |
| Handle corrompido | reempacote com `argus pack-context` (não edite `.argus/packed-handles`) |

> Arquivos do projeto nunca são alterados pela recuperação — só o `.argus/` é tocado.
