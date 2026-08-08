# Superfície MCP

Afeta: [mcp, retrieval, packing, memoria, install]

### DEC-010 — Catálogo MCP unificado (12 tools)

Catálogo registrado: 10 tools de código + `remember` + `recall`. CallTool aceita o catálogo completo. Síntese LLM (`think`), `dream`, `doctor` e `rebuild` não são tools MCP públicas na v1 (CLI/daemon ou flag interna).

### DEC-011 — ListTools default slim (5)

Sem `ARGUS_MCP_TOOLS`, ListTools expõe exatamente: `explore`, `pack_context`, `recall`, `remember`, `status` (nessa ordem). Env inválida/vazia cai no mesmo default — nunca abre as 12 em silêncio. `ARGUS_MCP_TOOLS=all` lista o catálogo completo.

### DEC-012 — `retrieve` unlisted no default

`retrieve` permanece fora do ListTools default; handles vêm de `explore`/`pack_context` e CallTool continua válido.

### DEC-013 — Absorção do Athena

Athena vira módulo interno `packages/argus/src/memory/`. Sem CLI `athena`, sem servidor MCP Athena separado, sem pacote npm `athena-knowledge-vault`.

### DEC-014 — Enriquecimento interno código↔memória

`explore`, `semantic_search` e `pack_context` podem anexar/fundir cofre de conhecimento internamente; o agente não precisa orquestrar código vs memória na maioria dos casos.

### DEC-015 — Estado unificado em `.argus/`

CLI, MCP, hooks, daemon e memória leem/escrevem o mesmo `<rootPath>/.argus/` (índice, dirty, lock, memory, packed-handles).

### DEC-016 — Path feliz alinhado a ListTools

Agent-rules e ListTools contam a mesma história: quase tudo → `explore`; decisões → `remember`/`recall`; multi-fonte/budget → `pack_context`.

### DEC-017 — `install --refresh` atualiza regras e MCP

Upgrade/`install --refresh` refresca o bloco de agent-rules e a entry MCP — não basta documentar “rode install de novo”.

### DEC-018 — stdout MCP limpo

Nenhum `console.log` no caminho stdio. Diagnóstico em stderr / modo quiet.
