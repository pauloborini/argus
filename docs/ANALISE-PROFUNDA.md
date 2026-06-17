# Atlas Cortex — Análise Profunda e Roadmap de Evolução

> Relatório técnico minucioso da CLI, daemon, tools, storage, extração e
> processos internos, com foco em **eficiência de tokens** e em posicionar a
> ferramenta como a melhor forma de dar contexto de código a agentes de IA.
>
> Data: 2026-06-16 · Versão analisada: 1.0.1 · Escopo: `packages/cortex/src/**`,
> docs, benchmark, plugins. Baseado em auditoria por subsistema + pesquisa do
> estado da arte (Serena, aider repomap, SCIP/LSIF, embeddings, guidance da
> Anthropic sobre design de tools MCP).

---

## 1. Sumário executivo

Atlas Cortex já acerta o mais difícil: **a tese**. Indexar uma vez e responder
perguntas estruturais ("onde está, quem chama, o que quebra, me dê só o
contexto") em vez de o agente reler arquivos é exatamente a direção que o
estado da arte valida (Serena, aider, e a própria guidance de "context
engineering" da Anthropic). A base também é sólida: tree-sitter de verdade em 7
linguagens, SQLite + FTS5, envelope de honestidade (`state`/`confidence`/
`limitations`), daemon de auto-sync e fiação zero-toque (`cortex install`).

Mas a implementação atual deixa **a maior parte do ganho de tokens na mesa** e
tem **um bug que pode quebrar a sessão MCP**, além de um **teto de escala** que
torna a ferramenta lenta exatamente nos repositórios grandes que são o alvo do
produto. Os três problemas de maior severidade:

1. **🔴 Corrupção do stream JSON-RPC do MCP.** O auto-sync roda antes de cada
   tool call e chama `runSync`, que imprime `console.log`/`console.warn` no
   **stdout** — o mesmo canal que o transporte stdio do MCP usa para o
   protocolo. Sempre que o índice está sujo, texto não-JSON é intercalado no
   stream e pode derrubar a conexão com o agente. *(server.ts:271 → sync.ts:256-314)*

2. **🟠 Teto de escala duplo por tool call.** Cada chamada (a) **desserializa o
   índice SQLite inteiro** para objetos JS (N+1 queries + 2 `JSON.parse` por
   arquivo) e (b) faz um **walk completo do filesystem** para checar staleness
   (mais 2 spawns de `git`). Em repos de dezenas de milhares de arquivos são
   centenas de ms a segundos por chamada. Pior: `trace`/`impact` reconstroem o
   **grafo inteiro em JS** a cada chamada em vez de consultar SQL.
   *(stubs.ts:449-558, staleness.ts:22, stubs.ts:1150-1264)*

3. **🟠 Desperdício estrutural de tokens (o core do produto).** Tudo é
   serializado com `JSON.stringify(payload, null, 2)` (pretty-print = ~30-40%
   dos tokens em whitespace), `confidence` é 100% derivável de `state`, prosa em
   português se repete em toda resposta, e há duplicação intra-payload
   (`trace.files`/`symbols` derivam de `hops`; `relevant_files` emite `name`
   idêntico a `path`). *(server.ts:280, response-state.ts:23, stubs.ts:90-112)*

E uma ressalva de credibilidade: **o benchmark do README (−88% tokens / −41%
tool calls) é sintético e auto-avaliado** — os dois lados são scripts
hard-coded, sem agente real e sem tokenizer real (chars/4). O número provável é
bom, mas a forma atual não o sustenta publicamente.

A boa notícia: as correções de maior impacto são **baratas e de baixo risco**
(serialização compacta, eliminar o full-load, WAL, mover grafo para SQL), e o
caminho "revolucionário" (overview-first/body-on-demand + ranking PageRank +
embeddings opcionais) é incremental sobre o que já existe.

---

## 2. Visão geral da arquitetura

```
                 ┌─────────────────────────────────────────────┐
   Editor/IDE ──▶│  Daemon (1 por usuário, @parcel/watcher)     │
   (salva)       │  watch → debounce 400ms → runSync(paths)     │
                 └───────────────┬─────────────────────────────┘
                                 │ escreve
   Git hooks ───▶ dirty-flag ───▶│  .cortex/  (workspace.json,
   (opcional)                    │   file-manifest.json, index.db)
                                 │
   Agente IA ──▶ MCP stdio ──────┤  serve --mcp
   (Claude/Cursor)  9 tools      │   ├─ autoSyncIfDirty()  ← antes de CADA call
                                 │   └─ buildToolStub() → SQLite/FTS + grafo JS
                                 └─────────────────────────────────────────────┘
```

**Camadas (todas em `packages/cortex/src`):**

| Camada | Arquivos-chave | Papel |
|---|---|---|
| CLI | `cli.ts`, `commands/*` | Commander; 1 subcomando por verbo + lifecycle |
| MCP | `mcp/server.ts`, `mcp/tools/stubs.ts` (3120 linhas) | 9 tools sobre o índice; auto-sync |
| Daemon | `daemon/{runtime,watcher,pipeline,registry,lock,service}.ts` | watch/debounce/sync, serviço launchd/systemd |
| Discovery | `discovery/{walk,delta,git-delta,fingerprint,staleness,manifest,dirty-flag}.ts` | inventário, deltas, staleness |
| Extração | `extraction/**`, `extractors/{ts,py,go,java,rust,kotlin,dart}.ts`, `parsers/registry.ts` | tree-sitter → símbolos/edges |
| Storage | `storage/{sqlite-*,index-persistence}.ts` | schema, FTS5, persistência |
| Contratos | `contracts/response-state.ts` | envelope de honestidade |

A superfície de comandos (ver `COMMANDS.md`) é coerente e bem documentada. Os 9
verbos (`search`, `explore`, `trace`, `impact`, `diff_impact`, `files`,
`pack_context`, `retrieve`, `status`) são bem escolhidos e **não** devem ser
fundidos num mega-tool (isso piora a seleção do agente — ver §7).

---

## 3. Achados por subsistema

### 3.1 Eficiência de tokens — o coração do produto

Este é o eixo mais importante (o produto existe para gastar menos tokens do
agente) e é onde há mais ganho fácil.

**A "taxa de pretty-print".** `mcp/server.ts:280` serializa toda resposta com
`JSON.stringify(payload, null, 2)`. Para os payloads array-of-objects que essas
tools emitem (candidatos, símbolos, arquivos, afetados), o pretty 2-spaces roda
**~1.4-1.6× a contagem de tokens do JSON compacto** — ou seja, ~30-40% dos
tokens de saída são whitespace puro. O mesmo padrão está em todos os comandos
CLI (`pack-context.ts:16`, `retrieve.ts:6`, `explore.ts:15`, `search.ts:14`,
`status.ts:7`) e no benchmark (`run-mvp.ts:142`). **Trocar para
`JSON.stringify(payload)` é ganho de ~30-40% em toda resposta, risco zero.**

**O envelope custa mais do que entrega.**
- `confidence` é 100% derivável de `state` (`response-state.ts:23-34`, função
  mecânica nunca sobrescrita). Emiti-lo é redundância pura.
- `message`/`limitations` são quase sempre frases estáticas em português; as
  constantes `PARTIAL_*` (`stubs.ts:90-112`) recorrem em toda chamada. Pior:
  até índices **fresh** retornam envelope `parcial` com
  `FTS_RETRIEVAL_PENDING` (`stubs.ts:749-752`), então a frase "Resultados
  dependem da cobertura estrutural…" viaja de carona na **maioria** das
  respostas bem-sucedidas — ruído, não sinal.
- Já existem códigos `E_*` (`stubs.ts:90`) que carregam o sinal sem a prosa.

**Duplicação intra-payload** (mesma informação, múltiplas vezes):
- `trace` emite `files[]` e `symbols[]` **derivados inteiramente de `hops`**
  (`toTracePathPayload`, stubs.ts:1300-1322) e `uncertainty_points` com
  `reason` == `detail` (stubs.ts:1338).
- `impact`/`diff_impact` repetem `files[]`/`tests[]` que são subconjuntos dos
  refs já emitidos.
- `explore` emite `relevant_files[]` com `name` **idêntico** a `path`
  (stubs.ts:826-856) e objetos `imports` crus.
- O **mesmo path longo** (60+ chars) aparece 5-6× num único payload `explore`
  (em `summary`, `central_symbols`, `relevant_files.name`+`.path`, `snippets`,
  `origin_refs`). Uma tabela de paths interná­vel (dictionary) ataca isso direto.

**`pack_context` — o diferencial subaproveitado.**
- O "budget" é `Math.ceil(text.length / 4)` (`approximateTokenCount`,
  stubs.ts:1922) — **não há tokenizer real** em lugar nenhum. `token_budget` e
  `token_estimate` são apresentados ao agente como autoritativos, mas podem
  estourar o budget real em código (muitos tokens curtos).
- A "compactação" é **truncar nas 4 primeiras linhas** (stubs.ts:2426), que são
  justamente o scaffolding em português (`Fonte:`, `Objetivo local:`, `Resumo:`)
  — um segmento "resumido" frequentemente fica **sem código nenhum**.
- O scaffolding em português é contado contra o `token_budget` do usuário: a
  tool gasta o orçamento do agente com os próprios rótulos.
- O mecanismo de **retrieve-handle é sólido** (regex validada, defesa contra
  path-traversal com `isWithinPath` testada, degradação honesta), mas: grava em
  disco com pretty-JSON (stubs.ts:2169), persiste o conjunto **inteiro** de
  segmentos mesmo quando só um foi cortado, e **não tem GC/eviction** —
  `.cortex/packed-handles/` cresce sem limite.

### 3.2 Daemon, sync e concorrência

**🔴 Bug crítico — stdout corrompe o JSON-RPC.** Descrito no §1.1. É o defeito
mais sério: o caminho quente (`autoSyncIfDirty` → `runSync`) escreve no mesmo
canal que o protocolo MCP possui. Correção: rotear toda diagnose de `runSync`
para **stderr** (ou um logger no-op quando invocado programaticamente) e nunca
deixar código de biblioteca chamar `console.log`.

**🟠 Steal de lock pode matar um sync vivo.** `sync-lock.ts:69` rouba o lock se
`age > STALE_LOCK_MS` (60s) **mesmo com o dono vivo**. Um `index` inicial de
monorepo grande que passe de 60s tem o lock roubado no meio da escrita →
**dois escritores concorrentes → corrupção** de manifest/DB. O daemon-lock tem
classe de race parecida (TOCTOU no steal de lock com pid morto, `lock.ts:44`),
sem o guard "não roube lock recém-criado vazio" que o sync-lock tem.

**🟠 Debounce sem teto de espera (starvation).** `pipeline.ts:38-46` rearma o
timer a cada evento. Um fluxo contínuo de saves (<400ms) rearma para sempre e
**nenhum sync dispara** — o índice fica stale indefinidamente durante
desenvolvimento ativo, exatamente o cenário que o daemon existe para cobrir.
Falta um `maxDebounceMs` (ex.: 3s desde o primeiro evento não-sincronizado).

**🟠 Fallback frágil quando o daemon está down.** Hooks git são opt-in
(`install.ts`, só com `--with-hooks`). Sem daemon **e** sem hooks, edições de
working-tree não-git não escrevem a dirty-flag, e o auto-sync do MCP vê
`hasDirtyPaths === false` e serve **índice stale silenciosamente**. A garantia
"zero-toque" depende do daemon estar de pé.

**Outros (médio/baixo):** limites de inotify/`max_user_watches` não detectados
(eventos podem ser dropados em silêncio; poll só roda após erro explícito);
symlinks não seguidos pelo watcher; delete de diretório pode orfanar entradas
indexadas (`explicit-delta.ts:62` assume que o watcher emite filhos, o que é
backend-dependente); launchd usa `load -w` (deprecado) e plist sem
`WorkingDirectory`/`EnvironmentVariables` (daemon pode resolver `XDG_*`
diferente do installer); tmp files `*.<pid>.tmp` órfãos em crash.

### 3.3 Storage SQLite e escala

**🟠 Full-load do índice em toda tool call.** `buildSemanticStubEnvelope`
(stubs.ts:449-558) chama `loadStructuralIndexForRead` para **toda** call.
`readAllFileEntries` (sqlite-index-store.ts:209-275) faz: 1 query de arquivos +
**2 queries preparadas por arquivo** (símbolos, edges → N+1) + **2 JSON.parse
por arquivo**, materializando o grafo inteiro. Para 50k arquivos
(`MAX_FILE_COUNT`, ignores.ts:17): ~100k queries + ~100k parses + dezenas a
centenas de MB de heap transitório — **e quase tudo é jogado fora**, porque
`search` só precisa dos hits do FTS (que já saem do SQL).

**🟠 Staleness re-walka o filesystem em toda call.** `computeManifestStaleness`
(staleness.ts:22) roda um `discoverFiles` completo + 2 spawns de `git` por
chamada de `status` e por toda tool semântica. Em repo grande são dezenas de
milhares de `statSync` + 2 subprocessos git **por tool call**.

**🟠 Grafo reconstruído em JS a cada call.** `buildTraceAdjacency`
(stubs.ts:1150-1264) reconstrói o grafo símbolo/arquivo/call inteiro em memória
em **toda** chamada de trace/impact, depois BFS. `findFilesBySymbolName`,
`resolveCallTargets` e o scan de importadores são O(arquivos×símbolos) em JS —
o que índices em `symbols(name)`/`edges(target)` resolveriam em SQL.

**Sem WAL.** Os únicos pragmas são `foreign_keys = ON` (sqlite-db.ts:67). Sem
`journal_mode = WAL` nem `busy_timeout`, um leitor (search readonly) e um
escritor (sync) **bloqueiam um ao outro**, e o `SQLITE_BUSY` resultante é
mapeado como **corrupção** (`E_INDEX_CORRUPTED`, sqlite-index-store.ts:70-77) —
o usuário é mandado reconstruir o índice por causa de um lock transitório.

**Ranking lexical fraco.** `searchFtsInternal` roda BM25 **e** uma passada
`LIKE`, e no merge as linhas lexicais (com `rank = 0`) entram primeiro e
**sobrescrevem** o rank BM25 real (sqlite-index-store.ts:376). O re-rank em JS
(`scoreCandidate`, stubs.ts:614-646) limita o boost BM25 a `0.09`, então BM25 é
praticamente constante. Sem peso de coluna (nome deveria pesar mais que
path/kind). Efetivamente é ranking lexical com FTS só para recall.

**Detecção de mudança por mtime, hash desperdiçado.** O fingerprint computa
sha256 (fingerprint.ts), mas `planManifestSync` (delta.ts:41) e a staleness
comparam **só size+mtime**. Resultado: edição que preserva tamanho+mtime (ex.:
`git checkout` que restaura mtime) fica **stale com status `fresh`** (falso
negativo, perda de dados); e formatadores que reescrevem bytes idênticos
forçam re-extração (falso positivo). O hash é pago e não protege.

**Migrações sem ladder.** `MIGRATION_VERSION = 1` fixo, sem caminho
`v1→v2`; `assertCompatibleIndexSchema` joga exceção em qualquer mismatch — toda
mudança de schema = "delete e reindexe" para o usuário.

### 3.4 Extração e precisão do grafo

A camada de parsing é boa: **tree-sitter de verdade** em todas as linguagens
(registry.ts), não regex. A fragilidade está nos **extractors** (walk raso +
switch por tipo de nó) e na **resolução**.

**🔴 (correção) Erros de parse nunca são detectados.** Todo extractor hardcoda
`parse_errors: []` (typescript.ts:164, python.ts:84, go.ts:67, java.ts:86,
rust.ts:68, kotlin.ts:72, dart.ts:139). Tree-sitter é error-recovering — em erro
de sintaxe retorna árvore com nós `ERROR`/`MISSING` em vez de lançar — mas
**nada inspeciona `node.hasError`/`tree.rootNode.hasError`**. Consequência: um
arquivo que falha o parse produz **símbolos-lixo parciais** e ainda conta como
`files_parsed += 1` (coverage.ts:76), inflando a cobertura. Toda a maquinaria de
coverage/limitations e a coluna `parse_errors_json` viram **código morto**. É a
maior lacuna de correção, e a correção é barata (~0.5 dia).

**Resolução de chamadas imprecisa (global fallback).** Edges de call guardam só
o texto do callee, sem resolução. `callTargetName` reduz `a.b.c` a `c`
(stubs.ts:995) e `resolveCallTargets` cai em **match global por nome**
(stubs.ts:1050) — qualquer `get`/`run`/`build`/`handle` se espalha para **todo
símbolo com esse nome no repo**, gerando muitas edges espúrias. O código é
honesto (anota `uncertain`), mas a precisão é baixa. `from_symbol` nunca é
setado na extração; o caller é recuperado por heurística post-hoc
(`findOwningSymbol`), errada para closures/lambdas e calls top-level.

**Resolução de import só existe para TS/JS** e só para `./` relativo
(extract-file.ts:21-55). Para Python/Go/Java/Rust/Kotlin/Dart o `resolved_path`
é **sempre undefined**, então o grafo de import file-level (`imports`/
`imported_by`, stubs.ts:1186) é **vazio** nessas linguagens — o impacto
cross-file fora de TS/JS depende inteiramente do match global ruidoso.

**Lacunas por linguagem:** Dart (partial, usado em Flutter) **não produz edge de
call nenhuma**; Rust sem edges de `impl`/trait; Go sem kind `interface` e sem
embedding; Python extrai extends do `argument_list` inteiro (mistura
`metaclass=`/keyword args/`Generic[T]` como superclasse); TS registra
arrow-const como `variable` e não `function`. **Faltam linguagens inteiras**:
C/C++, C#, Ruby, PHP, Swift, Scala — todas com grammar tree-sitter madura.

**Efeito downstream:** o grafo é honesto sobre limitações *conhecidas* (flags
`uncertain`, notas de cobertura parcial), mas **cego** a dois modos de falha
silenciosa: erros de parse não detectados e o `resolved_path` undefined fora de
TS. Um consumidor que lê `coverage_level: "full"` para Go/Python confia em edges
cross-file que **não existem**.

### 3.5 CLI / UX e superfície

Pontos fortes: superfície coerente, `cortex install` zero-toque, docs
bilíngues, exit code só ≠ 0 em `falha`, output scriptável com `jq`. O cuidado em
não usar `process.exit()` para não truncar stdout (cli.ts:53-59) mostra
maturidade.

Atritos: `stubs.ts` com **3120 linhas** é um monólito difícil de manter e
testar (deveria ser quebrado por tool); nomenclatura vestigial ("stub",
`SemanticStubEnvelope`) confunde — não são stubs, é lógica real; o plugin e o
README pinam `atlas-cortex@1.0.0` no args do MCP (plugins/.mcp.json, README)
enquanto o pacote é 1.0.1 (pin desatualizado); toda a prosa do produto é em
português, o que é uma escolha de produto, mas para consumo por máquina os
códigos `E_*` bastam.

---

## 4. Bugs e riscos priorizados

| # | Sev | Problema | Local | Correção |
|---|---|---|---|---|
| 1 | 🔴 | `runSync` escreve no stdout do MCP (quebra JSON-RPC) | server.ts:271, sync.ts:256-314 | logger → stderr / `quiet` |
| 2 | 🔴 | Erros de parse nunca detectados; cobertura inflada | extractors `parse_errors: []` | checar `rootNode.hasError` |
| 3 | 🟠 | Steal de sync-lock mata sync vivo → corrupção | sync-lock.ts:69 | só roubar se pid morto; refrescar mtime |
| 4 | 🟠 | Full-load do índice por tool call | stubs.ts:449-558 | desacoplar; query alvo |
| 5 | 🟠 | Staleness re-walka FS + 2 git por call | staleness.ts:22 | curto-circuito por dirty-flag |
| 6 | 🟠 | Sem WAL; SQLITE_BUSY vira "corrupção" | sqlite-db.ts:67 | `WAL` + `busy_timeout`; conexão persistente |
| 7 | 🟠 | Pretty-JSON desperdiça 30-40% de tokens | server.ts:280 (+CLI) | `JSON.stringify` compacto |
| 8 | 🟠 | Debounce sem teto → staleness indefinida | pipeline.ts:38 | `maxDebounceMs` |
| 9 | 🟠 | Daemon down + sem hooks = stale silencioso | server.ts/sync | fallback walk barato |
| 10 | 🟡 | mtime-only perde edições; hash desperdiçado | delta.ts:41, staleness.ts:58 | hash em 2 estágios |
| 11 | 🟡 | Grafo trace/impact reconstruído em JS | stubs.ts:1150 | mover para SQL indexado |
| 12 | 🟡 | `packed-handles/` cresce sem GC | stubs.ts:2123 | eviction por idade/tamanho |
| 13 | 🟡 | Pin `@1.0.0` no MCP args (≠ 1.0.1) | plugins/.mcp.json, README | usar latest/sem pin |

---

## 5. Credibilidade do benchmark

O `−88.1% tokens / −41.7% tool calls` do README **não é uma medição de
comportamento de agente** — é uma comparação sintética hand-scripted
(`run-mvp.ts:360-746`):

- **Os dois lados são hard-coded.** Cada task tem `buildBtNNBaseline` e
  `buildBtNNAtlas` com listas fixas de passos. O "−41.7% tool calls" é só
  `24 vs 14` — comprimentos de array que os autores escolheram.
- **Token = chars/4** (`estimateTokens`, run-mvp.ts:87), não tokenizer real. O
  baseline é o stdout cru de `rg -n` + `sed -n '440,470p'` (slices grandes de
  arquivo de propósito); o atlas é o stub. Ou seja, "colar 30 linhas de `sed`"
  vs "stub estruturado" — não é o baseline realista (um agente que lê o arquivo
  recebe o arquivo, não recola o `sed` como resposta).
- **Utilidade é auto-avaliada** (`scoreUtility`, run-mvp.ts:200-214) com
  respostas escritas pelos autores para passar nas barras; `uncertaintyDisclosure`
  é sempre `true`. O "4.17/5" é praticamente garantido por construção.
- **As metas do gate (−35%/−25%) são menores que o headline (−41%/−88%)**.

Recomendação: re-rodar com (a) tokenizer real (tiktoken/contagem Anthropic),
(b) serialização compacta, (c) baseline realista (file reads, não `sed`
recolado), idealmente (d) um agente vivo. Reportar a contribuição do **índice**
separada da contribuição do **formato**. Até lá, qualificar o número no README
como "limite superior interno scriptado".

> **✅ Resolvido (item 21).** `run-mvp.ts` foi reescrito: três arms (baseline
> file-reads → formato-só → atlas), ground-truth verificável por task (sem
> auto-pontuação; `uncertaintyDisclosure` medido), tokenizer subword offline
> (heurística documentada, sem `chars/4`), e split cirúrgica×varredura. Headline
> honesto: **−92,7% tokens / −11,8% tool calls**, atlas acerta **6/6**. A
> decomposição expõe que o ganho de **formato é ~0%** (whitespace quase não
> tokeniza) e quase tudo vem do **índice** entregar menos conteúdo; o índice
> compensa muito mais em **cirúrgica (−97,8%)** que em **varredura (−55,7%)**.
> Ainda é scriptado — agente vivo fica como follow-up (hook `runLiveAgent`
> reservado). Ver `.atlas/benchmark/latest/SUMMARY.md`.

---

## 6. Estado da arte — como nos posicionar

Síntese da pesquisa (Serena, aider, SCIP/LSIF, ctags/stack-graphs, embeddings,
guidance da Anthropic):

**Serena (LSP sobre MCP).** O maior ganho *real* de tokens do campo é o modelo
**overview-first / body-on-demand**: retornar outline de símbolos (assinatura +
path) e só puxar **um** corpo quando pedido. Precisão de LSP é o diferencial de
acurácia, mas é pesado (servidor por linguagem, cold start, crashes) e quebra a
simplicidade de "um SQLite". → **Adotar o modelo de interação** (é o core do
`pack_context`/`explore`); LSP só como enriquecimento opcional.

**aider repomap (tree-sitter + PageRank + budget).** Constrói mapa
token-budgeted: grafo de defs/refs, **PageRank com personalização** nos arquivos
em foco, e **busca binária do nº de tags para caber no budget**. Os pesos de
edge (nome longo ×10, privado ×0.1, nome comum em >5 defs ×0.1, referenciador
ativo ×50, `sqrt(num_refs)`) são sinal de ranking grátis e portável para SQL. →
**Adotar PageRank personalizado pela query** para alimentar `pack_context`/
`impact`/`trace`. É barato, local e cabe no SQLite que já temos.

**SCIP/LSIF (grafo preciso).** IDs de símbolo globalmente estáveis →
go-to-def/find-references corretos, sem falso-positivo de mesmo nome. Custo:
indexadores por linguagem que **precisam de build** e falham quando o build
falha. → **Ingerir** SCIP (não autorar) como tier opcional de precisão: se o
repo já emite `index.scip` em CI, carregar e deixar edges precisas
**sobrescreverem** as heurísticas; tree-sitter como fallback.

**ctags/stack-graphs.** ctags = só nome→linha, sem escopo (manter só como
último recurso para linguagens sem grammar). ⚠️ **`github/stack-graphs` foi
arquivado em 2025-09-09** — não criar dependência. Em vez disso, subir precisão
*dentro* do tree-sitter: resolver locals/params no escopo do arquivo antes do
match global, usar imports para desambiguar origem, e **taguear edges com
confiança**.

**Embeddings — opcional, off-by-default.** O quadro honesto de 2026: lexical
(FTS/BM25) é baseline mais forte do que se supõe e é **sempre fresco**; dense-só
é o método isolado mais fraco; **híbrido + rerank domina** (Recall@5 ~0.82 vs
~0.64 BM25 vs ~0.59 dense). Claude Code deliberadamente **não usa embeddings** e
ganha com busca agêntica. → Manter FTS5/BM25 + tree-sitter como default fresco.
Adicionar embeddings **atrás de flag**, reusando o chunking AST (evita o pior
pitfall de chunking), com **sqlite-vec brute-force int8 + bge-small**, fundido
via RRF com BM25, rerank opcional. Expor como **mais uma tool** que o agente
chama quando o lexical vem vazio — não um passo RAG obrigatório.

**Guidance da Anthropic sobre tools (o que torna isto "o melhor possível"):**
- **Handles + line ranges, nunca código inteiro.** O agente já tem acesso ao
  filesystem; inlinar código é desperdício. Uma tool `get(handle, context_lines)`
  expande sob demanda. (≈ "code execution with MCP": progressive disclosure,
  exemplo de 150k→2k tokens.)
- **`response_format: concise|detailed`** por tool, default concise (~3×).
- **Output tabular compacto (TSV/linha)** com header único para dados
  homogêneos; limite default ~50, cap ~25k tokens, e mensagem de truncamento que
  diz como refinar.
- **Field elision** + **IDs legíveis** (`module.Class.method`).
- **Declarar `outputSchema`/`structuredContent` do MCP** em toda tool
  (table-stakes; pré-requisito para code-execution depois).
- Token-efficient tool use beta já é automático no Claude 4 — não inventar um
  DSL que o modelo precise aprender (preferir TSV/Markdown/JSON-elidido).

---

## 7. Roadmap priorizado

Organizado por **impacto/esforço**. Os três tiers são entregáveis independentes.

### Tier 0 — Correções urgentes (dias, risco baixo, alto retorno)

1. **[Bug 1] Tirar `runSync` do stdout no caminho MCP.** Logger → stderr ou
   flag `quiet`. *Sem isto, o auto-sync quebra sessões reais.*
2. **[Bug 2] Detectar `rootNode.hasError` e popular `parse_errors`.** Ativa a
   maquinaria de coverage/limitations já existente; para de inflar cobertura.
3. **[Bug 7] Serialização compacta** em `server.ts:280` e nos comandos CLI
   (`--pretty` opcional para humanos). **~30-40% menos tokens em tudo.**
4. **[Bug 6] WAL + `busy_timeout`** e **conexão persistente** no servidor MCP
   (em vez de open/close por call). Elimina SQLITE_BUSY-como-corrupção.
5. **[Bug 3] Steal de lock só com dono morto** + refrescar mtime em sync longo.

### Tier 1 — Eficiência de tokens e escala (1-2 semanas)

6. **Enxugar o envelope:** dropar `confidence` (derivável), trocar
   `message`/`limitations` por códigos `E_*` (prosa atrás de verbosity flag),
   `staleness_hint` como código. ~50-70% menos tokens de envelope, em toda call.
7. **Eliminar duplicação intra-payload:** remover `trace.files`/`symbols`
   (derivados de `hops`), `name` redundante em `relevant_files`, `files`/`tests`
   subconjuntos em impact/diff-impact; **dictionary de paths** para repos
   grandes.
8. **`response_format: concise|detailed`** por tool (default concise) + **field
   elision** quando vazio + **output TSV** para `files`/`search`.
9. **Matar o full-load no caminho de `search`/`files`** (Bug 4): não exigir
   `structuralIndex` completo; buscar language/coverage por candidato via query
   alvo.
10. **Cachear staleness** (Bug 5): curto-circuito por dirty-flag / mtime do topo
    antes do walk completo + git. No modelo daemon, confiar no watcher.
11. **Tokenizer real** em `pack_context` e no benchmark (Bug do §5);
    compactação que **preserva código**, não o scaffolding.

### Tier 2 — Precisão e capacidade ("revolucionar o uso com IA")

12. **Mover trace/impact para SQL indexado** (Bug 11): índices em
    `edges(target)`/`edges(from_symbol)`, BFS por hop com query (CTE recursiva).
    Remove o full-load *e* os scans O(arquivos×símbolos).
13. **Modelo overview-first / body-on-demand (Serena)** em `explore`/
    `pack_context`: outline + assinaturas, **handles + line ranges em vez de
    código**, expansão por `retrieve(handle, context_lines)`.
14. **PageRank personalizado pela query (aider)** para rankear
    `pack_context`/`impact`; portar os pesos de edge.
15. **Resolução de import por linguagem** + `from_symbol` na extração +
    preservar receiver no callee (Bugs de precisão §3.4). Maior ganho de acurácia
    cross-file em repos poliglotas.
16. **Embeddings opcionais** (sqlite-vec int8 + bge-small, híbrido RRF com BM25,
    rerank opcional) como **uma tool** que o agente chama quando o lexical falha.
17. **Ingestão SCIP opcional** como tier de precisão quando o repo emite
    `index.scip` em CI.
18. **Fechar lacunas por linguagem** (Dart calls, Rust impl, Go interface/
    embedding, Python extends, TS arrow-const) e **adicionar linguagens**
    (C/C++, C#, Ruby, PHP, Swift) — cada uma é dep de grammar + extractor.

### Tier 3 — Higiene e robustez

19. ~~Quebrar `stubs.ts` (3120 linhas) por tool; renomear "stub"/`Semantic*`.~~ ✅
20. ~~`maxDebounceMs` (Bug 8); fallback daemon-down (Bug 9); GC de handles
    (Bug 12); ladder de migração; modernizar launchd/systemd com env explícito;
    corrigir pin `@1.0.0` (Bug 13); detecção de exaustão de inotify.~~ ✅
    *Fechado:* maxDebounce, fallback daemon-down, GC de handles já entregues;
    pin `@1.0.0`→`@latest` no README; env explícito (PATH+HOME) no plist/unit
    (`resolveServiceEnv`) — sem isso o `git` do Homebrew some sob launchd/systemd
    e o auto-sync falha mudo; exaustão de inotify detectada com hint acionável
    (`watcherExhaustionHint`) + backoff direto ao máximo (polling cobre). A
    "ladder de migração" fica como **rebuild-on-mismatch** intencional: o índice
    é local e barato de reconstruir, então schema incompatível lança
    `E_INDEX_SCHEMA_INCOMPATIBLE` instruindo `cortex index` em vez de migrar
    passo-a-passo (evita carregar migrações mortas).
21. ~~Re-benchmark honesto (§5) e separar contribuição de índice vs formato.~~ ✅

---

## 8. Conclusão

A aposta do produto está certa e o estado da arte a confirma. O que separa o
Atlas Cortex de "bom" para "a melhor forma de dar contexto a um agente" é
**execução em três frentes**: (1) parar de vazar tokens no formato (Tier 0-1 já
entrega o grosso do "−88%" de forma *honesta*), (2) remover o teto de escala
(full-load + walk + grafo em JS → SQL/WAL/lazy), e (3) subir um degrau de
capacidade com o modelo overview-first + ranking PageRank + embeddings
opcionais, sem abrir mão do local-first e da honestidade que já são o
diferencial.

Os ganhos mais "revolucionários" (Tier 2) são **incrementais** sobre o que já
existe — o índice tree-sitter + SQLite já é a fundação correta para todos eles.
O caminho recomendado: **Tier 0 imediatamente** (um deles é um bug que quebra
sessões), **Tier 1 a seguir** (é literalmente o produto: menos tokens), e então
**Tier 2** para abrir distância da concorrência.

---

### Apêndice — Mapa de referências (file:line)

- Serialização / token: `mcp/server.ts:280`, `mcp/server.ts:271` (auto-sync),
  `contracts/response-state.ts:23` (confidence derivável), `stubs.ts:90-112`
  (prosa repetida), `stubs.ts:749-752` ("sempre parcial"), `stubs.ts:1922`
  (chars/4), `stubs.ts:2426` (truncação 4 linhas).
- Daemon/sync: `commands/sync.ts:256-314` (console.* no stdout),
  `concurrency/sync-lock.ts:69` (steal), `daemon/lock.ts:44`,
  `daemon/pipeline.ts:38` (debounce), `daemon/watcher.ts`,
  `discovery/explicit-delta.ts:62`, `daemon/service.ts:104-130`.
- Storage/escala: `mcp/tools/stubs.ts:449-558` (full-load),
  `storage/sqlite-index-store.ts:209-275` (N+1), `discovery/staleness.ts:22`
  (walk por call), `storage/sqlite-db.ts:67` (sem WAL),
  `storage/sqlite-index-store.ts:376` (merge desfaz BM25),
  `discovery/delta.ts:41` (mtime-only), `stubs.ts:1150-1264` (grafo em JS).
- Extração: extractors `parse_errors: []`
  (`typescript.ts:164`/`python.ts:84`/`go.ts:67`/`java.ts:86`/`rust.ts:68`/
  `kotlin.ts:72`/`dart.ts:139`), `stubs.ts:995` (`callTargetName`),
  `stubs.ts:1050` (global fallback), `extract-file.ts:21-55` (import só TS),
  `language.ts:7-24` (linguagens suportadas).
- Benchmark: `benchmark/run-mvp.ts:360-746` (arms scriptados),
  `run-mvp.ts:87` (chars/4), `run-mvp.ts:200-214` (utilidade auto-avaliada).
