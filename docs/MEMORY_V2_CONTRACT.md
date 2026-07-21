# Contrato técnico — memória v2 (S02 + persistência S03 + hot path Plano 4)

Documento canônico do contrato de dados da memória v2 do Argus. Fixa nomes, regras e casos negativos; a **persistência** no SQLite local foi implementada em S03; o **hot path** `remember → FTS/embedding → recall` e o **ranking v2** em Plano 4.

**Referências:** PRD S02 §3 D1–D6; PRD S03 write path; tipos em `packages/argus/src/memory/v2-contract.ts`; colunas em `packages/argus/src/memory/v2-persistence-draft.ts`; migração em `packages/argus/src/memory/storage/sqlite-v2-migrate.ts`; schema em `packages/argus/src/memory/storage/sqlite-schema.ts`; hot-update em `packages/argus/src/memory/hot-updater.ts`; ranking em `packages/argus/src/memory/memory-retrieval.ts`.

**Runtime atual:** `MEMORY_SQLITE_SCHEMA_VERSION = "2.0.0"`. A tabela `notes` persiste os campos v2 (`scope`, `source`, `confidence`, temporalidade, supersedência, sinais e `migrated_from_v1`). `openMemoryDb` em modo **write** aplica migração forward-only e idempotente de bancos `1.0.0`. `notes_fts` e `note_embeddings` permanecem operacionais. Ranking de leitura aplica fatores v2 (confidence, recência, stale, contradiction) sobre o score-base FTS/RRF.

**Diagnóstico:** `VaultEngine.status` expõe `schema_version` e `schema_v2_ready`. Abertura **readonly** de banco v1 não dispara migração — `schema_v2_ready` fica `false` até a primeira abertura em write (`sync`, `remember`, etc.).

---

## 1. Escopos (`scope`)

| Valor wire | Status | Semântica |
|------------|--------|-----------|
| `project` | ativo | Repo/workspace atual |
| `user` | ativo | Operador humano |
| `session` | ativo | Sessão ou dia de trabalho |
| `agent` | ativo | Identidade do agente |
| `org` | **reservado** | Reconhecido no vocabulário; **rejeitado para gravação** |

- Todo fato v2 pertence a **exatamente um** escopo ativo.
- Default na migração S03 para notas v1: `project` (explícito via `sqlite-v2-migrate.ts`).
- Escopo desconhecido ou `org` → erro acionável na gravação; nenhum dado salvo.

### Caso negativo — escopo não autorizado

Tentativa de gravar com `scope: "org"` ou `scope: "team"` → rejeição com código `E_MEMORY_V2_SCOPE_REJECTED` e mensagem indicando escopos ativos permitidos.

---

## 2. Fonte (`source`)

Obrigatória; **nunca** string vazia.

| Valor wire | Descrição |
|------------|-----------|
| `direct_capture` | Captura direta (usuário ou `remember`) |
| `agent_inference` | Inferência de agente |
| `v1_migration` | Migrado de nota v1 |
| `document_import` | Importação de documento |

Entrada vazia ou desconhecida na gravação → rejeição (`E_MEMORY_V2_SOURCE_INVALID`). Na migração S03, notas v1 recebem `v1_migration`.

---

## 3. Confiança (`confidence`)

Obrigatória no contrato; ausência assume o nível **mais conservador** (`presumed`).

| Valor wire | Nível |
|------------|-------|
| `confirmed` | Confirmado explicitamente |
| `inferred` | Inferido |
| `presumed` | Presumido (default conservador) |

---

## 4. Temporalidade

| Campo wire | Tipo | Regra |
|------------|------|-------|
| `observed_at` | ISO 8601 | Quando o fato foi observado/capturado (**obrigatório** em `MemoryV2FactFields`) |
| `valid_from` | ISO 8601 opcional | Início da janela de validade |
| `valid_until` | ISO 8601 opcional | Fim da validade; escopo `session` pode expirar com o fim da sessão |

Campos v1 `created_at` / `updated_at` permanecem para compatibilidade FTS/sync.

---

## 5. Supersedência

| Campo wire | Regra |
|------------|-------|
| `superseded_by` | ID do fato vigente no mesmo escopo; origem **não é apagada** |
| `supersedes` | Referência reversa opcional para auditoria |

Fato com `superseded_by` preenchido permanece armazenado e recuperável; leitura padrão (S05) prefere o vigente.

### Caso negativo — fato supersedido

Fato A (`id: fa`) no escopo `project` é atualizado por fato B (`id: fb`). Após supersedência: A mantém conteúdo e ganha `superseded_by: "fb"`; B pode ter `supersedes: "fa"`. Nenhuma linha é removida de `notes`.

---

## 6. Staleness e contradição

Sinais explícitos com **motivo acionável** (texto ou código estruturado) — nunca booleano solto nem `state: sucesso` pleno quando há stale/contradição vigente.

| Campo wire | Quando |
|------------|--------|
| `stale_reason` | Fato sem confirmação no horizonte do escopo (ex.: sessão encerrada) |
| `contradiction_reason` | Dois fatos vigentes no mesmo escopo com conteúdo conflitante |

Leitores (`recall`, `semantic_search domain=memory|all`) expõem esses sinais nos resultados e no `rank_reason`.

### Caso negativo — fonte stale

Fato de escopo `session` com `valid_until` no passado → resultado de leitura inclui `stale_reason` (ex.: `"session_expired"`) e não apresenta o fato como certeza plena.

### Caso negativo — contradição vigente

Dois fatos ativos em `project` contradizem-se → leitura sinaliza `contradiction_reason` (ex.: `"conflicting_values_same_scope"`) em vez de retornar apenas um como definitivo.

---

## 7. Compatibilidade v1 (forward-only)

| Aspecto | Regra |
|---------|-------|
| Tabelas v1 | `notes`, `notes_fts`, `note_embeddings` continuam pesquisáveis |
| Campo `type` v1 | Categoria da nota (`inbox`, `decision`, …) — **distinto** de `scope` |
| `migrated_from_v1` | ID/path da nota v1 de origem após migração S03 |
| Migração | Forward-only; origem v1 só substituída após confirmação de sucesso (D6) |
| MCP | Tools registradas intactas; `remember`/`recall` sem novos parâmetros obrigatórios |

---

## 8. Leitura por escopo/tempo e ranking v2

| Leitor | Contrato |
|--------|----------|
| `recall` | Filtrar por escopo ativo e janela temporal antes de apresentar fatos como vigentes; reranquear com fatores v2 |
| `semantic_search` (`domain=memory\|all`) | Preservar `stale_reason` / `contradiction_reason` em candidatos de memória |
| Superseded | Não vencem fatos vigentes no ranking padrão; permanecem recuperáveis para auditoria |

### 8.1 Score-base e fatores (defaults P5)

1. Filtros de vigência (scope, `valid_from`, `superseded_by`, sources) aplicam-se **antes** do ranking.
2. Score-base vem de FTS (BM25 normalizado) ou RRF híbrido.
3. Fatores v2 monotônicos (constante `MEMORY_V2_RANKING_WEIGHTS`):

| Fator | Default | Efeito |
|-------|---------|--------|
| `confidence.confirmed` | 1,20 | Multiplica score-base |
| `confidence.inferred` | 1,05 | Multiplica score-base |
| `confidence.presumed` | 1,00 | Neutro |
| Recência | meia-vida 90 dias, piso 0,70 | Decay suave; não zera fatos antigos |
| `stale` | 0,50 | Penaliza quando `stale_reason` presente |
| `contradiction` | 0,35 | Penaliza quando `contradiction_reason` presente |

Wire de auditoria: `rank_factors` (componentes) e `rank_reason` (ex.: `confirmed;stale:session_expired;recency:floor`).

`state: parcial` quando o conjunto vigente inclui stale ou contradiction.

---

## 9. Sync, embed e hot-update (caminhos distintos)

| Caminho | Owner | O que faz | O que **não** faz |
|---------|-------|-----------|-------------------|
| `VaultEngine.sync` | vault-engine | Rebuild completo notes/FTS/grafo a partir do vault Markdown | **Destrutivo:** apaga `note_embeddings` (e notes/FTS) no rebuild; exige `embed` depois se quiser denso de novo |
| `VaultEngine.embed` | vault-engine | Upsert incremental de `note_embeddings` para notas já no SQLite; remove órfãos | **Não** chama `sync`; **não** faz `DELETE` global de embeddings válidos |
| `hotUpdateNoteProjection` | `hot-updater.ts` | Upsert **de uma nota** + FTS em transação; atualiza `memory_meta` | Não chama `sync`; não `DELETE` global; não remove embeddings de outras notas |
| `hotUpdateNoteEmbedding` | `hot-updater.ts` | Embed **de uma nota** sob `HOT_EMBED_MAX_CHARS` | Não wipe; preserva embeddings alheios |

### 9.1 Hot path de `remember`

1. Grava Markdown v2 no vault.
2. Chama `hotUpdateNoteProjection` (transação SQLite: upsert `notes` + `notes_fts`).
3. Se corpo ≤ `HOT_EMBED_MAX_CHARS` e embedder disponível (`options.embedder` ou `createEmbedder()`), chama `hotUpdateNoteEmbedding` no mesmo request → `embedding_status: updated|unchanged|failed|pending`.
4. Se embedder indisponível, corpo acima do budget, ou `ARGUS_HOT_EMBED=0` sem inject → `pending` + hint **`argus memory embed`** (nunca `memory sync` como retry de indexação quente).
5. FTS fica imediatamente disponível para `recall`/`search` mesmo com embedding pendente.
6. Se a projeção falhar após o Markdown existir → `state: parcial`, código `E_MEMORY_HOT_INDEX_FAILED` / `E_MEMORY_HOT_NOTE_MISSING`, retry idempotente (mesmo path não duplica FTS).

O request MCP/CLI de `remember` **nunca** deve chamar `VaultEngine.sync`. Hints pós-remember apontam `argus memory embed`, não sync.

### 9.2 Degradação de embedding

- Sem embeddings → `recall`/`search` usam FTS (`mechanism: fts-only`), estado honesto com limitation.
- Hot path não bloqueia captura por falha/custo de embed.
- `sync` full continua **destrutivo** para embeddings (rebuild estrutural do vault); operação explícita frio — **não** usar sync no hot path nem como ritual pós-remember.
- `embed` batch é incremental (upsert + limpeza de órfãos); não depende de wipe via sync.

---

## 10. Mapa campo → módulo

| Campo PRD §5 | Wire TS / SQLite |
|--------------|------------------|
| Escopo | `scope` — `v2-contract.ts`, coluna `notes.scope` |
| Fonte | `source` |
| Confiança | `confidence` |
| Observação | `observed_at` |
| Validade | `valid_from`, `valid_until` |
| Supersedência | `superseded_by`, `supersedes` |
| Stale | `stale_reason` |
| Contradição | `contradiction_reason` |
| Origem v1 | `migrated_from_v1` |
| Ranking | `MEMORY_V2_RANKING_WEIGHTS`, `applyV2RankingFactors` |
| Hot index | `hotUpdateNoteProjection`, `hotUpdateNoteEmbedding` |
