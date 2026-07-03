# Contrato técnico — memória v2 (S02)

Documento canônico do contrato de dados da memória v2 do Argus. **Não implementa** migração, write path nem leitura por escopo — apenas fixa nomes, regras e casos negativos para S03–S05.

**Referências:** PRD S02 §3 D1–D6; schema runtime v1 em `packages/argus/src/memory/storage/sqlite-schema.ts`; tipos em `packages/argus/src/memory/v2-contract.ts`; draft de persistência em `packages/argus/src/memory/v2-persistence-draft.ts`.

**Runtime atual:** `MEMORY_SQLITE_SCHEMA_VERSION = "1.0.0"` — tabelas `notes`, `notes_fts`, `note_embeddings` permanecem inalteradas nesta sprint.

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
- Default planejado na migração S03 para notas v1: `project` (explícito, não silencioso).
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

Leitores futuros (`recall`, `semantic_search domain=memory|all`) devem expor esses sinais nos resultados (S05).

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
| MCP | 12 tools inalteradas; `remember`/`recall` sem novos parâmetros obrigatórios nesta sprint |

---

## 8. Leitura futura por escopo/tempo (S05)

| Leitor | Contrato |
|--------|----------|
| `recall` | Filtrar por escopo ativo e janela temporal antes de apresentar fatos como vigentes |
| `semantic_search` (`domain=memory\|all`) | Preservar `stale_reason` / `contradiction_reason` em candidatos de memória |
| Superseded | Não vencem fatos vigentes no ranking padrão; permanecem recuperáveis para auditoria |

---

## 9. Mapa campo → módulo

| Campo PRD §5 | Wire TS / SQL draft |
|--------------|---------------------|
| Escopo | `scope` — `v2-contract.ts`, `v2-persistence-draft.ts` |
| Fonte | `source` |
| Confiança | `confidence` |
| Observação | `observed_at` |
| Validade | `valid_from`, `valid_until` |
| Supersedência | `superseded_by`, `supersedes` |
| Stale | `stale_reason` |
| Contradição | `contradiction_reason` |
| Origem v1 | `migrated_from_v1` |
