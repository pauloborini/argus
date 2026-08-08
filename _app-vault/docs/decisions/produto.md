# Produto

Afeta: [retrieval, packing, memoria, mcp, cli]

### DEC-001 — Agent-first, local-first, sem UI

Produto sem dashboard, graph canvas, chat UI ou tours como entrega. Interface: MCP + CLI enxuta.

### DEC-002 — Identidade operacional Argus

Nome do produto: Argus. CLI e servidor MCP: `argus`. Slug/repo: `argus`. Subtítulo: Local code retrieval and context packing for agents.

### DEC-003 — Dois resultados de produto

Foco mensurável: (1) reduzir chamadas de tool na exploração/refactor; (2) reduzir tokens enviados ao modelo sem piorar o contexto útil.

### DEC-004 — Índice local confiável e honesto

Staleness, `state` e limitations são honestos. Nunca fingir cobertura. `parcial` é raro e acionável, não default cosmético.

### DEC-005 — Contexto textual pronto

Respostas devem devolver contexto que a LLM usa sem remontar quebra-cabeça. Overview-only que força cascata de Read viola esta regra.

### DEC-006 — Reversibilidade

Compressão forte exige caminho de recuperação (`retrieve` / handles) do original quando possível.

### DEC-007 — Design para refactor

Impacto, fluxo, mudança segura e testes afetados continuam first-class — mesmo se unlisted no ListTools default, CLI/skills preservam a capacidade.

### DEC-008 — Sem egress de código por default

Embeddings e sync são locais. Sem enviar código a cloud embedding API por default.

### DEC-009 — Precedência de regras do repo

Pedido do usuário > `AGENTS.md` / `CLAUDE.md` / project-rules > práticas de stack > padrões locais.
