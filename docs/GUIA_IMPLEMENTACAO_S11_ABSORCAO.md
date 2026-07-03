# Guia de implementação — S11 Absorção Athena → Argus

**Versão:** 1.0  
**Data:** 2026-07-02  
**ADR base:** [`docs/adr/001-athena-absorption-and-mcp-surface.md`](./adr/001-athena-absorption-and-mcp-surface.md)  
**Repos envolvidos:**

| Repo | Caminho | Papel |
|------|---------|-------|
| Argus (destino) | `/Volumes/Dados/projetos/argus` | Produto unificado |
| Athena (origem) | `/Volumes/Dados/projetos/athena` | Código a absorver e depois arquivar |

**Premissas:** sem usuários externos; breaking changes aceitáveis; um único binário `argus`, um MCP, um diretório `.argus/`.

---

## Índice

1. [Definition of Done](#definition-of-done)
2. [Pré-requisitos](#pré-requisitos)
3. [Gates globais](#gates-globais)
4. [Matriz de port — código Athena](#matriz-de-port--código-athena)
5. [Matriz de port — testes Athena](#matriz-de-port--testes-athena)
6. [Mudanças em package.json](#mudanças-em-packagejson)
7. [Fase S11a — Scaffold e layout em disco](#fase-s11a--scaffold-e-layout-em-disco)
8. [Fase S11b — Port do módulo memory + CLI + MCP remember/recall](#fase-s11b--port-do-módulo-memory--cli--mcp-rememberrecall)
9. [Fase S11c — Enriquecimento das 10 tools](#fase-s11c--enriquecimento-das-10-tools)
10. [Fase S11d — pack_context unificado + synthesize interno](#fase-s11d--pack_context-unificado--synthesize-interno)
11. [Fase S11e — Deprecação Athena standalone](#fase-s11e--deprecação-athena-standalone)
12. [Breaking changes e migração](#breaking-changes-e-migração)
13. [Riscos e decisões em aberto](#riscos-e-decisões-em-aberto)

---

## Definition of Done

A absorção está **concluída** quando todos os itens abaixo forem verdadeiros:

- [ ] `packages/argus/src/memory/` contém o cofre portado; **não** há imports de `athena` no Argus
- [ ] Layout `.argus/memory/` funciona; migração `.athena/` → `.argus/memory/` é idempotente
- [ ] MCP expõe **12 tools**: 10 existentes + `remember` + `recall`
- [ ] CLI `argus memory *` cobre init/remember/sync/embed/search/dream/doctor/rebuild
- [ ] `argus install` inicializa memória por default (`--no-memory` opt-out)
- [ ] Testes portados passam: `npm run validate` no Argus
- [ ] `explore`, `semantic_search`, `pack_context`, `status` enriquecidos conforme ADR
- [ ] `retrieve` aceita `rh_*` e `mh_*`
- [ ] Repo Athena marcado deprecated / arquivado; `ArgusBridge` removido
- [ ] `COMMANDS.md`, `README.md`, bloco `agent-rules` atualizados

---

## Pré-requisitos

```bash
# Branch de trabalho no Argus
cd /Volumes/Dados/projetos/argus
git checkout -b feat/s11-athena-absorption

# Baseline verde antes de começar
npm run validate

# Athena acessível para copy/port (não submodule — leitura manual)
ls /Volumes/Dados/projetos/athena/src
```

**Versões alinhadas (já compatíveis hoje):**

| Dependência | Argus | Athena |
|-------------|-------|--------|
| Node | `>=20` | `>=20` |
| `better-sqlite3` | `^11.10.0` | `^11.10.0` |
| `commander` | `^13.1.0` | `^13.1.0` |
| `@modelcontextprotocol/sdk` | `^1.12.1` | `^1.12.1` |
| `zod` | `^3.25.28` | `^3.25.28` |
| `vitest` | `^4.1.8` | `^4.1.8` |

---

## Gates globais

Rodar ao final de **cada fase** (mínimo):

```bash
cd /Volumes/Dados/projetos/argus
npm run typecheck
npm test
npm run lint
npm run build
```

Gate estendido (S11b+):

```bash
npm run validate          # typecheck + test + lint + build
npm run smoke:package     # tarball instalável + smoke CLI/MCP
npm run homologate        # smoke multi-repo de retrieval útil
```

Gate manual por feature de memória:

```bash
argus memory init
printf "# nota\n" | argus memory remember --stdin
argus memory sync
argus memory search "teste"
argus serve --mcp         # ListTools deve listar 12 tools
```

---

## Matriz de port — código Athena

### Origem → destino

| # | Athena (`src/`) | Argus destino | Ação |
|---|-----------------|---------------|------|
| 1 | `core/vault-engine.ts` (879 LOC) | `memory/vault-engine.ts` | Port + rename paths/config |
| 2 | `core/hybrid-search.ts` (261) | `memory/hybrid-search.ts` | Port; trocar embedder para Argus `embeddings/embedder.ts` |
| 3 | `core/embed-engine.ts` (109) | `memory/embed-engine.ts` | Port; usar `createEmbedder()` Argus |
| 4 | `core/think-engine.ts` (177) | `memory/think-engine.ts` | Port; uso interno apenas |
| 5 | `core/dream-engine.ts` (426) | `memory/dream-engine.ts` | Port |
| 6 | `core/markdown-parser.ts` (141) | `memory/markdown-parser.ts` | Port |
| 7 | `core/llm-provider.ts` (124) | `memory/llm-provider.ts` | Port |
| 8 | `core/gap-analyzer.ts` (55) | `memory/gap-analyzer.ts` | Port |
| 9 | `core/config.ts` (127) | `memory/config.ts` | Port; renomear `AthenaConfig` → `MemoryConfig`; remover `argus_db_path` |
| 10 | `core/hot-updater.ts` (27) | `memory/hot-updater.ts` | Port se ainda usado por dream |
| 11 | `core/embedding-provider.ts` (65) | — | **Não portar** — substituído por `embeddings/embedder.ts` |
| 12 | `core/argus-bridge.ts` (189) | — | **Não portar** — substituído por `CodeIndexReader` interno |
| 13 | `storage/sqlite-db.ts` (128) | `memory/storage/sqlite-db.ts` | Port; renomear `AthenaDbSchemaError` → `MemoryDbSchemaError`; não carregar `sqlite-vec` |
| 14 | `storage/sqlite-schema.ts` (143) | `memory/storage/sqlite-schema.ts` | Port; adaptar embeddings para int8 |
| 15 | `utils/paths.ts` (64) | `memory/paths.ts` | Reescrever: resolver sob `.argus/memory/` |
| 16 | `utils/logger.ts` (22) | Reusar `../output.js` ou criar `memory/logger.ts` fino | Preferir logger compartilhado se existir; senão port mínimo |
| 17 | `cli.ts` (303) | `commands/memory/*.ts` | Não portar monolito; extrair por comando |
| 18 | `mcp.ts` (164) | `mcp/tools/remember.ts`, `mcp/tools/recall.ts` | Só handlers das 2 tools novas |
| 19 | `index.ts` (31) | `memory/index.ts` | Re-export público interno do módulo |

### Novos arquivos Argus (não existem no Athena)

| Arquivo | Responsabilidade |
|---------|------------------|
| `memory/code-index-reader.ts` | Leitura readonly de `.argus/index.db` (substitui `ArgusBridge`) |
| `memory/migrate-legacy-athena.ts` | Migra `.athena/` → `.argus/memory/` com backup do DB legado |
| `memory/paths.ts` | `getMemoryDir()`, `getVaultDir()`, `getMemoryDbPath()`, `getMemoryConfigPath()` |
| `commands/memory/init.ts` | `argus memory init` |
| `commands/memory/remember.ts` | `argus memory remember` |
| `commands/memory/sync.ts` | `argus memory sync` |
| `commands/memory/embed.ts` | `argus memory embed` |
| `commands/memory/search.ts` | `argus memory search` |
| `commands/memory/dream.ts` | `argus memory dream` |
| `commands/memory/doctor.ts` | `argus memory doctor` |
| `commands/memory/rebuild.ts` | `argus memory rebuild` |
| `mcp/tools/remember.ts` | Handler MCP `remember` |
| `mcp/tools/recall.ts` | Handler MCP `recall` |

### Arquivos Argus existentes a modificar

| Arquivo | Mudança |
|---------|---------|
| `cli.ts` | Subcomando `memory` com 8 ações |
| `mcp/tool-registry.ts` | Adicionar `remember`, `recall` em `MCP_TOOL_NAMES`, schemas, descriptions |
| `mcp/server.ts` | Zod schemas + dispatch para remember/recall |
| `mcp/tools/response.ts` | Cases `remember` / `recall` em `buildToolResponseAsync` |
| `mcp/tools/explore.ts` | Anexar `memory_refs[]` |
| `mcp/tools/semantic-search.ts` | Parâmetro `domain: code \| memory \| all` |
| `mcp/tools/pack.ts` | Sources `mh_*`, synthesize interno |
| `mcp/tools/status.ts` | Bloco `memory: { staleness, notes_count, ... }` |
| `commands/install.ts` | Passo memory init+sync; flag `--no-memory` |
| `commands/agent-rules.ts` | Documentar `remember`/`recall` no bloco |
| `workspace/workspace.ts` | Constantes `MEMORY_DIR`, helpers opcionais |
| `package.json` (argus) | `js-yaml`; manter `sqlite-vec` fora do pacote |
| `scripts/smoke-package.mjs` | Esperar 12 tools e exercitar init/memory |
| `scripts/homologate.mjs` | Incluir checagem leve de `status.memory` após init |
| `COMMANDS.md` / `README.md` | Seção memory + 12 tools |
| `CLAUDE.md` / `AGENTS.md` | Template do bloco agent-rules |

---

## Matriz de port — testes Athena

| Athena test | Destino Argus | Ação |
|-------------|---------------|------|
| `tests/sqlite-foundation.test.ts` | `tests/memory/sqlite-foundation.test.ts` | Port; paths `.argus/memory/` |
| `tests/vault.test.ts` | `tests/memory/vault.test.ts` | Port; `VaultEngine` via memory paths |
| `tests/sync-search.test.ts` | `tests/memory/sync-search.test.ts` | Port |
| `tests/think-engine.test.ts` | `tests/memory/think-engine.test.ts` | Port |
| `tests/dream.test.ts` | `tests/memory/dream.test.ts` | Port |
| `tests/mcp-server.test.ts` | `tests/memory/mcp-remember-recall.test.ts` | Reescrever para 2 tools + envelope Argus |
| `tests/cli-smoke.test.ts` | `tests/memory/cli-smoke.test.ts` | Port; invocar `argus memory` |
| `tests/argus-bridge.test.ts` | `tests/memory/code-index-reader.test.ts` | Reescrever sem bridge; reader direto |
| `tests/helpers/argus-bridge-test-helper.ts` | `tests/memory/helpers/code-index-fixture.ts` | Fixture mínima de `index.db` |

**Novos testes Argus (não existem no Athena):**

| Teste | O que valida |
|-------|----------------|
| `tests/memory/migrate-legacy.test.ts` | `.athena/` → `.argus/memory/` idempotente |
| `tests/tool-registry.test.ts` | Surface MCP exata com 12 tools; stubs de `remember`/`recall` |
| `tests/mcp-tools-enrichment.test.ts` | `explore` com `memory_refs`, `semantic_search domain=all` |
| `tests/pack-memory-handle.test.ts` | `mh_*` em pack_context + retrieve |

---

## Mudanças em package.json

`packages/argus/package.json` — adicionar:

```json
"js-yaml": "^4.1.0"
```

`devDependencies`:

```json
"@types/js-yaml": "^4.0.9"
```

**Não adicionar:** `@xenova/transformers`, `sqlite-vec`.

**Direção fechada:** usar embeddings int8 desde S11b. Manter `sqlite-vec` temporário parece mais rápido, mas cria dependência nativa pública, smoke extra e segunda migração. Não vale.

---

## Fase S11a — Scaffold e layout em disco

**Objetivo:** estrutura de pastas, paths, migração legado — sem MCP ainda.

### S11a-01 — Criar árvore `src/memory/`

```
packages/argus/src/memory/
├── index.ts
├── paths.ts
├── migrate-legacy-athena.ts
├── code-index-reader.ts
├── config.ts
├── vault-engine.ts          # stub ou port parcial
├── storage/
│   ├── sqlite-db.ts
│   └── sqlite-schema.ts
└── (demais engines na S11b)
```

**Aceite:** `npm run typecheck` passa com exports vazios/stubs.

### S11a-02 — Implementar `memory/paths.ts`

Substituir lógica de `athena/src/utils/paths.ts`:

| Função Athena | Função Argus | Resolve para |
|---------------|--------------|--------------|
| `getAthenaDir()` | `getMemoryRoot(cwd?)` | `{cwd}/.argus/memory` |
| `getVaultDir()` | `getVaultDir(cwd?)` | `{cwd}/.argus/memory/vault` |
| `getDatabasePath()` | `getMemoryDbPath(cwd?)` | `{cwd}/.argus/memory/memory.db` |
| `getConfigPath()` | `getMemoryConfigPath(cwd?)` | `{cwd}/.argus/memory/config.json` |
| `setCustomVaultPath()` | `setCustomMemoryRoot()` | Para testes |
| `ATHENA_VAULT_PATH` | `ARGUS_MEMORY_PATH` | Env override |

Manter `VAULT_SUBDIRS` idênticos: `entities`, `meetings`, `decisions`, `projects`, `references`, `inbox`.

**Aceite:** teste unitário `tests/memory/paths.test.ts` com tmpdir.

### S11a-03 — Estender `workspace/workspace.ts`

Adicionar (sem breaking):

```typescript
export const MEMORY_DIR = "memory";
export const MEMORY_DB_FILE = "memory.db";
export const MEMORY_CONFIG_FILE = "config.json";
export const MEMORY_VAULT_DIR = "vault";

export function getMemoryPath(cwd?: string): string;
export function getMemoryDbPath(cwd?: string): string;
```

**Aceite:** exports em `src/index.ts` opcionais; typecheck ok.

### S11a-04 — Implementar `migrate-legacy-athena.ts`

Comportamento:

1. Se `{cwd}/.athena/` existe e `{cwd}/.argus/memory/` **não** existe → mover/renomear:
   - `.athena/vault/` → `.argus/memory/vault/`
   - `.athena/athena-vault.db` → `.argus/memory/legacy-athena-vault.db` (backup; não abrir como runtime)
   - `.athena/config.json` → `.argus/memory/config.json` (reescrever paths internos)
2. Se destino já existe → no-op com log
3. Se `.athena/` vazio → no-op
4. Criar `memory.db` novo só via `argus memory sync`; nunca reaproveitar schema Athena ativo

Atualizar `config.json` migrado:

```json
{
  "vault_path": "<abs>/.argus/memory/vault",
  "db_path": "<abs>/.argus/memory/memory.db",
  "llm_provider": "...",
  "code_index_path": "<abs>/.argus/index.db"
}
```

Remover campo `argus_db_path`; adicionar `code_index_path` opcional.

Semântica de erro:

- Sem `.athena/`: `status: "skipped"`.
- `.athena/` + destino inexistente + sucesso: `status: "migrated"`.
- Destino já existe: `status: "skipped_existing_destination"`.
- Falha com `.athena/` presente: retornar `status: "failed"` + `message`; chamador deve hard-fail. Não continuar com migração parcial.

**Aceite:** `tests/memory/migrate-legacy.test.ts` — fresh, migrate, idempotent, failed-preserves-source.

### S11a-05 — Hook migração em `runInit` / `runInstall`

Em `commands/init.ts` e início de `commands/install.ts`:

```typescript
import { migrateLegacyAthena } from "../memory/migrate-legacy-athena.js";
const migration = migrateLegacyAthena(cwd);
if (migration.status === "failed") return 1;
```

**Aceite:** `argus init` em repo com `.athena/` legado produz `.argus/memory/`; em falha, `.athena/` permanece íntegro e comando retorna exit code 1.

### Gate S11a

```bash
npm run validate
npx vitest run tests/memory/paths.test.ts tests/memory/migrate-legacy.test.ts
```

---

## Fase S11b — Port do módulo memory + CLI + MCP remember/recall

**Objetivo:** cofre funcional standalone dentro do Argus; 12 tools no MCP.

### S11b-01 — Port storage layer

1. Copiar `athena/src/storage/sqlite-schema.ts` → `memory/storage/sqlite-schema.ts`
2. Copiar `athena/src/storage/sqlite-db.ts` → `memory/storage/sqlite-db.ts`
3. Renomes:
   - `AthenaDbSchemaError` → `MemoryDbSchemaError`
   - `getDatabasePath` imports → `../paths.js`
4. **Embeddings:** implementar int8 já na S11b:

| Tabela | Campos mínimos |
|--------|----------------|
| `note_embeddings` | `note_id`, `vector`, `scale`, `dim`, `content_hash` |
| `note_embeddings_meta` | `model`, `dim`, `built_at`, `note_count`, `vault_hash` |

Espelhar `storage/embeddings-store.ts`: `quantizeInt8`, blob int8, busca densa brute-force + RRF lexical. Não carregar `sqlite-vec`.

**Aceite:** port de `tests/memory/sqlite-foundation.test.ts` verde.

### S11b-02 — Port engines core

Ordem de dependência (respeitar):

```
markdown-parser → config → vault-engine
embedding (Argus embedder) → hybrid-search → embed-engine
gap-analyzer → think-engine
dream-engine (depende vault + embed + llm)
```

**Mudanças obrigatórias em cada arquivo portado:**

| Padrão Athena | Substituir por |
|---------------|----------------|
| `from "../utils/paths.js"` | `from "../paths.js"` |
| `from "./embedding-provider.js"` | `from "../../embeddings/embedder.js"` |
| `loadXenovaProvider()` | `createEmbedder()` |
| `ArgusBridge.getInstance()` | `CodeIndexReader.open(cwd)` |
| `AthenaConfig` | `MemoryConfig` |
| `getAthenaDir()` | `getMemoryRoot()` |
| Logs `[Athena ...]` | `[argus:memory]` |

### S11b-03 — Implementar `code-index-reader.ts`

API mínima (substitui `ArgusBridge`):

```typescript
export interface CodeRef {
  file: string;
  line: number;
  symbol: string;
}

export type CodeIndexStatus = "connected" | "unavailable" | "schema_mismatch";

export class CodeIndexReader {
  static open(cwd: string): CodeIndexReader;
  getStatus(): CodeIndexStatus;
  resolveSymbol(name: string, scope?: string): CodeRef[];
}
```

Abre `getIndexDbPath(cwd)` readonly; valida `index_meta.schema_version`.

**Aceite:** `tests/memory/code-index-reader.test.ts` (evolução de argus-bridge.test).

### S11b-04 — Port `vault-engine.ts`

Métodos a preservar (paridade Athena):

| Método | CLI/MCP |
|--------|---------|
| `VaultEngine.init()` | `argus memory init` |
| `VaultEngine.sync()` | `argus memory sync` |
| `VaultEngine.capture(content)` | `remember` |
| `VaultEngine.search(query, opts)` | `recall` (wrapper) |
| `VaultEngine.recall(query, opts)` | usado por `recall` |
| `VaultEngine.status()` | `argus memory doctor` |
| `VaultEngine.rebuild()` | `argus memory rebuild` |

Envelope de resposta: **migrar gradualmente** para `stubResponse` Argus (`sucesso`/`falha`/…) — na S11b aceitar envelope Athena internamente se necessário, normalizar na camada MCP.

**Aceite:** `tests/memory/vault.test.ts` + `sync-search.test.ts` verdes.

### S11b-05 — CLI `argus memory`

Em `cli.ts`:

```typescript
const memory = program.command("memory").description("Cofre de conhecimento local");
memory.command("init")...
memory.command("remember [text]")...
memory.command("sync")...
memory.command("embed")...
memory.command("search <query>")...
memory.command("dream")...
memory.command("doctor")...
memory.command("rebuild")...
```

Padrão de saída: alinhar ao Argus (JSON compacto, `state`, exit code ≠ 0 só em `falha`).

`remember` CLI:

```bash
argus memory remember "texto"
argus memory remember --stdin --type decision --tag s11 --link src/cli.ts
argus memory remember --file docs/nota.md
```

Não criar alias público `capture`; manter vocabulário igual ao MCP.

**Aceite:** `tests/memory/cli-smoke.test.ts` — init → remember via CLI → sync → search.

### S11b-06 — MCP `remember` e `recall`

#### `mcp/tool-registry.ts`

```typescript
export const MCP_TOOL_NAMES = [
  // ... 10 existentes ...
  "remember",
  "recall",
] as const;
```

Adicionar `TOOL_INPUT_JSON_SCHEMAS`, `TOOL_DESCRIPTIONS`.

#### `mcp/tools/remember.ts`

- Input Zod: `content`, `type?`, `tags?`, `links?`
- Chama `VaultEngine.capture()` ou método dedicado com frontmatter
- Resposta: envelope Argus + `note_path`, `note_id`

#### `mcp/tools/recall.ts`

- Input: `query`, `limit?`, `include_snippets?`
- Chama `hybridSearch` / `VaultEngine.recall`
- Resposta: `mechanism`, `chunks[]` — **sem LLM**

#### `mcp/server.ts`

Registrar schemas Zod espelhando registry.

#### `mcp/tools/response.ts`

Adicionar cases em `buildToolResponseInner` e `buildToolResponseAsync`. Atualizar comentários/contagens que hoje assumem 10 tools ou "outras 9".

**Aceite:** `tests/memory/mcp-remember-recall.test.ts` — ListTools = 12; round-trip remember+recall.

### S11b-07 — Port think + dream (interno)

- Port `think-engine.ts`, `dream-engine.ts`, `llm-provider.ts`, `gap-analyzer.ts`
- `think` **não** registrado no MCP
- `argus memory dream` chama `DreamEngine.run()`

**Aceite:** `tests/memory/think-engine.test.ts`, `dream.test.ts` verdes.

### S11b-08 — `argus install` com memória

`commands/install.ts`:

```typescript
export interface InstallOptions {
  // ...
  noMemory?: boolean;
}
```

Após passo 2 (índice código):

```typescript
if (!options.noMemory) {
  await runMemoryInit();
  await runMemorySync();
  summary.push("cofre de memória inicializado");
}
```

CLI: `--no-memory` no `install`.

Ordem: `migrateLegacyAthena` → `runMemoryInit` → `runMemorySync`. Se migração falhar com `.athena/` presente, `install` deve retornar falha antes de registrar MCP/daemon.

**Aceite:** `argus install` em repo limpo cria `.argus/memory/vault/inbox/`; `argus install --no-memory` não cria `.argus/memory/`; repo com `.athena/` corrompido não perde origem e falha cedo.

### Gate S11b

```bash
npm run validate
npm run smoke:package
npm run homologate
# smoke manual
argus memory init
printf "# nota\n" | argus memory remember --stdin
argus memory sync
argus memory search nota
```

---

## Fase S11c — Enriquecimento das 10 tools

**Objetivo:** código e memória fundidos sem novas tools públicas.

### S11c-01 — `explore` + `memory_refs`

Arquivo: `mcp/tools/explore.ts`

Após montar resposta estrutural, chamar helper `findMemoryRefs(cwd, target, mode)`:

1. Se `mode=file` → notas com wiki-link para path ou tag = basename
2. Se `mode=symbol` → notas que mencionam símbolo (FTS em `memory.db`)
3. Se `mode=topic` → FTS no cofre com query = target

Adicionar ao payload:

```typescript
memory_refs?: Array<{
  path: string;
  title: string;
  score: number;
  reason: string;
}>;
```

Limit default: 5 refs; não falhar se memória indisponível (`limitations`).

**Aceite:** teste com nota linkando `src/cli.ts` → explore retorna ref.

### S11c-02 — `semantic_search` + `domain`

Arquivo: `mcp/tools/semantic-search.ts`, `commands/semantic-search.ts`

Novo arg:

```typescript
domain?: "code" | "memory" | "all"; // default "code"
```

| domain | Comportamento |
|--------|---------------|
| `code` | Atual (sem mudança) |
| `memory` | Só `memory/hybrid-search` |
| `all` | RRF entre candidatos código + notas; prefixos `symbol:` e `note:` |

Também atualizar:

- `mcp/tool-registry.ts` JSON Schema com `domain`.
- `mcp/server.ts` Zod com `domain`.
- `cli.ts` / `commands/semantic-search.ts` com `--domain <code|memory|all>`.
- `SemanticSearchArgs` em `mcp/tools/semantic-search.ts`.

**Aceite:** `tests/mcp-tools-enrichment.test.ts` — `domain=all` retorna ambos tipos; `domain=code` preserva comportamento atual.

### S11c-03 — `status` + bloco memory

Arquivo: `mcp/tools/status.ts`

Adicionar:

```typescript
memory?: {
  initialized: boolean;
  staleness: "fresh" | "stale" | "unknown";
  notes_count: number;
  last_sync_at: string | null;
  embeddings_ready: boolean;
};
```

Ler via `VaultEngine.status()` ou query leve em `memory.db`.

Semântica: memória ausente ou corrompida não deve transformar `status` do índice de código em `falha`; preencher `memory.initialized=false` ou `memory.staleness="unknown"` e adicionar `limitations`.

**Aceite:** status com cofre vazio vs populado; status sem memória continua útil para código.

### Gate S11c

```bash
npm run validate
npx vitest run tests/mcp-tools-enrichment.test.ts
```

---

## Fase S11d — pack_context unificado + synthesize interno

**Objetivo:** um pacote para a LLM com código + memória; handles `mh_*`.

### S11d-01 — Handles de memória `mh_*`

Arquivo: `mcp/tools/pack.ts` (ou extrair helper `packed-memory-handles.ts`)

| Prefixo | Conteúdo | Storage |
|---------|----------|---------|
| `rh_*` | Pack de código (existente) | `.argus/packed-handles/` |
| `mh_*` | Chunk/nota de memória | `.argus/packed-handles/` |

Funções:

```typescript
function isValidMemoryHandle(h: string): boolean;
function registerMemoryHandle(cwd, noteId, chunk?): string;
function readMemoryHandle(cwd, handle): { content, path, title };
```

Atualizar:

- `isValidRetrieveHandle` em `mcp/tools/pack.ts` → aceitar `rh_` **ou** `mh_`.
- `TOOL_INPUT_JSON_SCHEMAS.retrieve.properties.handle.pattern` → `^(rh|mh)_[a-f0-9]{16}$`.
- Zod em `mcp/server.ts` → mesmo regex.
- GC de `packed_handles` → preservar os dois prefixos.

**Aceite:** `tests/pack-memory-handle.test.ts`.

### S11d-02 — `pack_context` aceita fontes de memória

Estender resolução de `sources` em `pack.ts`:

| Source pattern | Resolve para |
|----------------|--------------|
| `rh_*` | Existente |
| `mh_*` | Nota/chunk memória |
| `memory:rel/path.md` | Nota por path relativo ao vault |
| `note:123` | Nota por id |
| path/símbolo | Existente (código) |

Segmentos de memória no pack:

```
Fonte: memory:decisions/adr-001.md
Título: ADR absorção
---
(conteúdo markdown truncado ao budget)
```

**Aceite:** pack com `sources: "memory:decisions/foo.md,src/cli.ts"` mistura ambos.

### S11d-03 — `synthesize` interno (opcional v1)

Estender `PackContextArgs`:

```typescript
synthesize?: boolean;  // default false
```

Se `true` e `llm_provider != none`:

1. Montar pack normal
2. Chamar `ThinkEngine.think(goal, { context: pack, dryRun: false })`
3. Retornar `synthesis`, `citations`, `gaps` no payload

Não expor como tool separada. `synthesize` é só campo opcional de `pack_context`.

**Aceite:** teste com `dry_run`/mock LLM em `think-engine.test.ts`.

### S11d-04 — Consolidar embeddings memória (int8)

Checklist final:

1. `memory/storage/sqlite-schema.ts` não referencia `vec0` / `sqlite-vec`.
2. `memory/embed-engine.ts` usa `quantizeInt8` + tabela alinhada ao código.
3. `package.json` e lockfile não têm `sqlite-vec`.

**Aceite:** `argus memory embed` + `recall` com `mechanism: hybrid-rrf`; `rg "sqlite-vec|vec0" packages/argus/src package.json package-lock.json` não retorna nada.

### Gate S11d

```bash
npm run validate
npm run smoke:package
npm run homologate
```

---

## Fase S11e — Deprecação Athena standalone

**Objetivo:** um produto, um repo ativo.

### S11e-01 — Documentação Argus

Atualizar:

- `README.md` / `README.pt-BR.md` — "code + memory"
- `COMMANDS.md` — seção `argus memory` + 12 MCP tools
- `CLAUDE.md` / `AGENTS.md` — bloco agent-rules
- `CHANGELOG.md` — entrada BREAKING v2.0.0

### S11e-02 — Agent rules

Bloco sugerido em `commands/agent-rules.ts`:

```markdown
## Argus

### Código (índice local)
- search, explore, trace, impact, diff_impact, files, pack_context, retrieve, status, semantic_search

### Memória (cofre local)
- remember — capturar decisão/insight
- recall — buscar no cofre (sem LLM)

pack_context aceita código + memória; prefira pack_context a múltiplas tools.
```

### S11e-03 — Repo Athena

1. `README.md` → banner **DEPRECATED — absorvido pelo Argus**
2. Apontar para `github.com/pauloborini/argus`
3. Último tag/release opcional
4. Arquivar repo ou manter read-only

### S11e-04 — Remover referências cruzadas

- Deletar `athena/src/core/argus-bridge.ts` (já no Argus como `code-index-reader`)
- Grep em ambos repos: zero `athena_capture`, `athena_mcp`, `.athena/` em código Argus exceto migrator

### S11e-05 — Versão Argus

Bump **2.0.0** por mudança de produto e migração Athena: `argus install` passa a preparar memória por default, `.athena/` é absorvido/deprecado e o pacote passa a publicar cofre + code retrieval num runtime único. As 2 tools novas são aditivas para Argus; não usar isso como justificativa de breaking isolada.

```bash
npm run release:check
```

### Gate S11e (final)

```bash
cd /Volumes/Dados/projetos/argus
npm run validate
npm run smoke:package
npm run homologate
npm run release:check

# checklist manual
argus install
argus status          # código + memory
argus memory doctor
# MCP: 12 tools listadas
```

---

## Breaking changes e migração

| Antes | Depois |
|-------|--------|
| `athena init` | `argus memory init` ou `argus install` |
| `athena mcp` / MCP server `athena` | `argus serve --mcp` / server `argus` |
| `.athena/` | `.argus/memory/` (migração automática) |
| `ATHENA_VAULT_PATH` | `ARGUS_MEMORY_PATH` |
| `athena-vault.db` | `legacy-athena-vault.db` backup; `memory.db` novo via sync/embed |
| MCP tools `athena_*` (4) | `remember`, `recall` (+ enriquecimento interno) |
| `config.argus_db_path` | `config.code_index_path` (opcional) |
| Embeddings MiniLM + sqlite-vec | bge-small + int8 (re-embed obrigatório) |

**Script de migração manual (usuário = você):**

```bash
cd <repo>
argus install              # migra .athena se existir
argus memory sync          # cria/recria memory.db
argus memory embed         # re-gerar vetores
# Remover MCP athena dos hosts (install do argus sobrescreve)
```

---

## Riscos e decisões em aberto

| ID | Risco / decisão | Mitigação | Decidir em |
|----|-----------------|-----------|------------|
| R1 | Port int8 atrasar S11b | Não aceitar `sqlite-vec`; implementar store simples espelhado no Argus | S11b-01 |
| R2 | Envelope Athena (`sucesso`) vs Argus (`state`) | Normalizar na borda CLI/MCP; core pode migrar em etapas | S11b-05 |
| R3 | Dois `sqlite-db.ts` no mesmo processo | Namespaces `memory/storage` vs `storage`; sem singleton global compartilhado | S11b-01 |
| R4 | Migração parcial de `.athena/` | Migrador fail-closed; backup DB legado; teste `failed-preserves-source` | S11a |
| R5 | Tamanho do pacote npm (+js-yaml, modelo HF em cache runtime) | Já existe transformers no Argus; validar com `smoke:package` | S11b+ |
| R6 | Dream cycle no daemon | Não entra na S11; hook no `daemon/pipeline.ts` fica pós-S11e | pós-S11e |
| R7 | `think` como tool/CLI separada aumentar roteamento | ADR: sem tool separada; só `pack_context.synthesize` opcional | S11d |

---

## Ordem de commits sugerida

| Commit | Conteúdo |
|--------|----------|
| 1 | `feat(memory): scaffold paths + migrate legacy (S11a)` |
| 2 | `feat(memory): port storage + vault engine (S11b-01..04)` |
| 3 | `feat(memory): CLI argus memory (S11b-05)` |
| 4 | `feat(mcp): remember + recall tools (S11b-06)` |
| 5 | `feat(memory): think + dream internal (S11b-07)` |
| 6 | `feat(install): memory init on install (S11b-08)` |
| 7 | `feat(mcp): enrich explore + semantic_search + status (S11c)` |
| 8 | `feat(mcp): pack_context memory handles + synthesize (S11d)` |
| 9 | `feat(memory): int8 embeddings unified (S11d-04)` |
| 10 | `docs!: absorption complete + bump 2.0.0 (S11e)` |

---

## Referência rápida — 12 tools MCP finais

```
search | explore | trace | impact | diff_impact | files
pack_context | retrieve | status | semantic_search
remember | recall
```

**Contratos detalhados:** ver ADR-001, seções "Contratos das 2 tools novas" e "Enriquecimento interno".

---

*Documento gerado para execução incremental. Atualizar checkboxes na Definition of Done conforme fases concluídas.*
