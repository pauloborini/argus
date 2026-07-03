# ADR-001: Absorção do Athena e superfície MCP unificada (12 tools)

**Status:** Aceito  
**Data:** 2026-07-02  
**Contexto:** Argus (code retrieval) + Athena (knowledge vault) devem virar um produto único. Não há usuários externos — breaking changes são aceitáveis.

---

## Decisão

1. **Absorver o Athena** como módulo interno `packages/argus/src/memory/` — sem CLI `athena`, sem servidor MCP separado, sem pacote npm `athena-knowledge-vault`.
2. **Manter as 10 tools MCP atuais** do Argus inalteradas em nome e contrato base.
3. **Adicionar 2 tools** de memória na superfície pública: `remember` e `recall`.
4. **Enriquecer internamente** `explore`, `semantic_search` e `pack_context` com o cofre de conhecimento — o agente não precisa orquestrar código vs memória na maioria dos casos.
5. **Unificar estado em disco** sob `.argus/` (ver layout abaixo).

---

## Superfície MCP (12 tools)

### Código (10 — existentes)

| Tool | Papel |
|------|--------|
| `search` | FTS de símbolos |
| `explore` | Contexto estrutural (símbolo/arquivo/tema) |
| `trace` | Fluxo entre pontos indexados |
| `impact` | Blast radius |
| `diff_impact` | Impacto do diff Git |
| `files` | Árvore indexada |
| `pack_context` | Empacotar contexto com token budget + handles |
| `retrieve` | Reidratar handle `rh_*` |
| `status` | Saúde do índice (código + memória) |
| `semantic_search` | Busca semântica/híbrida |

### Memória (2 — novas)

| Tool | Papel | Substitui (Athena) |
|------|--------|---------------------|
| `remember` | Capturar nota, decisão ou insight no cofre | `athena_capture` |
| `recall` | Busca híbrida **somente** no cofre; retorna chunks citáveis, sem LLM | `athena_search` + `athena_recall` |

### O que **não** expor como tool MCP

| Capacidade Athena | Destino |
|-------------------|---------|
| `athena_think` (síntese LLM + gap analysis) | Interno: flag opcional em `pack_context` (`synthesize: true`) ou path futuro `explore --synthesize` — **não** tool pública na v1 |
| `dream` cycle | Comando CLI `argus memory dream` + daemon (background) |
| `doctor` / `rebuild` | `argus memory doctor` / `argus memory rebuild` |

**Rationale:** Leitura e escrita explícitas (`recall` / `remember`) cobrem o que o agente precisa decidir. Síntese com LLM é caro e ambíguo como tool — melhor acoplar a `pack_context` quando o objetivo já está declarado (`goal`).

---

## Enriquecimento interno (sem novas tools)

| Tool existente | Comportamento após absorção |
|----------------|----------------------------|
| `explore` | Se o alvo casar símbolo/arquivo, anexar notas ligadas (tags, wiki-links, `argus_db_path` legado, path overlap) em `memory_refs[]` |
| `semantic_search` | Novo parâmetro opcional `domain`: `code` (default) \| `memory` \| `all`. `all` funde rankings (RRF) código + cofre |
| `pack_context` | `sources` aceita handles de memória (`mh_*`) além de paths/símbolos/`rh_*`; monta pacote unificado |
| `status` | Reporta staleness de `index.db` **e** `memory.db` + último sync do vault |

---

## Layout em disco unificado (`.argus/`)

```
.argus/
├── workspace.json          # product_id: "argus", schema_version bump
├── file-manifest.json      # inventário código (existente)
├── index.db                # índice estrutural + embeddings de código (existente)
├── dirty.json              # flag código (existente)
├── memory/
│   ├── vault/              # markdown fonte (ex-.athena/vault/)
│   │   ├── entities/
│   │   ├── meetings/
│   │   ├── decisions/
│   │   ├── projects/
│   │   ├── references/
│   │   └── inbox/
│   ├── memory.db           # índice FTS + vec do cofre (ex-athena-vault.db)
│   └── config.json         # LLM keys, embed model, paths (ex-.athena/config.json)
└── handles/                # opcional: rh_* e mh_* no mesmo store ou tabelas distintas
```

**Migração:** `argus install` detecta `.athena/` legado e move para `.argus/memory/` (one-shot, idempotente).

---

## Módulo interno `src/memory/`

Mapeamento Athena → Argus (rename, não copy-paste cego):

| Athena | Argus `memory/` |
|--------|-----------------|
| `vault-engine.ts` | `vault-engine.ts` |
| `hybrid-search.ts` | `hybrid-search.ts` |
| `embed-engine.ts` | `embed-engine.ts` |
| `think-engine.ts` | `think-engine.ts` (uso interno) |
| `dream-engine.ts` | `dream-engine.ts` |
| `markdown-parser.ts` | `markdown-parser.ts` |
| `llm-provider.ts` | `llm-provider.ts` |
| `gap-analyzer.ts` | `gap-analyzer.ts` |
| `argus-bridge.ts` | **removido** — acesso direto ao `index.db` irmão |
| `config.ts` | `config.ts` |
| `storage/sqlite-*` | `storage/sqlite-*` (schema próprio, `memory.db`) |
| `utils/paths.ts` | `paths.ts` → resolve sob `.argus/memory/` |

---

## Embeddings — decisão única

| Aspecto | Decisão |
|---------|---------|
| Biblioteca | `@huggingface/transformers` (já no Argus) — remover `@xenova/transformers` |
| Modelo | `Xenova/bge-small-en-v1.5` para **código e memória** |
| Armazenamento código | int8 quantizado (existente) |
| Armazenamento memória | Migrar de `sqlite-vec` para o mesmo padrão int8 **ou** manter `sqlite-vec` só em `memory.db` até convergir — **preferência: int8 unificado** para uma dependência a menos |

Re-embed obrigatório na migração Athena → Argus (modelos diferentes hoje).

---

## CLI (sem `athena` bin)

Namespace `argus memory`:

```bash
argus memory init          # vault + memory.db
argus memory sync          # markdown → SQLite
argus memory embed         # vetores do cofre
argus memory search <q>    # debug humano
argus memory dream         # ciclo de consolidação
argus memory doctor        # diagnóstico
argus memory rebuild       # rebuild completo do cofre
```

`argus install` passa a incluir `memory init` + primeiro `memory sync` quando `--with-memory` (default **on**).

---

## Contratos das 2 tools novas

### `remember`

```json
{
  "content": "string (markdown)",
  "type": "inbox | decision | meeting | entity | project | reference",
  "tags": ["opcional"],
  "links": ["opcional — wiki ou path"]
}
```

Resposta: envelope padrão + `note_path`, `note_id`.

### `recall`

```json
{
  "query": "string",
  "limit": 10,
  "include_snippets": true
}
```

Resposta: envelope + `mechanism` (`hybrid-rrf` | `fts-only`) + `chunks[]` com `path`, `title`, `score`, `snippet`. Sem chamada LLM.

---

## Handles de memória

- Código: `rh_<16hex>` (existente)
- Memória: `mh_<16hex>` (novo) — chunk ou nota inteira para `pack_context` / `retrieve`

`retrieve` aceita ambos os prefixos.

---

## Ordem de implementação sugerida

1. **S11a** — Scaffold `src/memory/`, layout `.argus/memory/`, migração `.athena/` → `.argus/memory/`
2. **S11b** — Port tests Athena → Argus; `remember` + `recall` MCP; CLI `argus memory *`
3. **S11c** — Enriquecimento `explore` + `semantic_search` (`domain`)
4. **S11d** — `pack_context` unificado + `mh_*`; `synthesize` interno opcional
5. **S11e** — Remover repo/pacote Athena standalone; atualizar docs e `install`

---

## Consequências

- Um MCP, um binário, um diretório `.argus/`
- Agentes registrados hoje continuam com as 10 tools; após upgrade ganham `remember`/`recall`
- Breaking: paths `.athena/` deprecados; MCP server `athena` removido
- `ArgusBridge` deixa de existir — leitura direta no processo

---

## Alternativas rejeitadas

| Alternativa | Motivo |
|-------------|--------|
| 14+ tools (expor `think`, `dream`, `capture`, `search` Athena) | Volta o problema de roteamento agente |
| Tool única `ask` orquestradora | Duplica `pack_context` + esconde debug; pode entrar depois se necessário |
| Manter dois repos / dois MCPs | Estado duplicado, sync manual, bridge frágil |
| Go rewrite do memory layer | Stack já é TS; absorção é copy-module, não rewrite |
