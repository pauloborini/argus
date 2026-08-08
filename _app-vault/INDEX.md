---
vault_version: 1
updated: 2026-08-07
scope: verdade vigente do Argus — retrieval, packing, MCP e memória local
---

# Argus — índice do vault

## Domínios

- [produto](docs/decisions/produto.md) — tese, identidade, honestidade, egress, precedência
- [mcp-surface](docs/decisions/mcp-surface.md) — catálogo MCP, ListTools slim, Athena, `.argus/`
- [memoria](docs/decisions/memoria.md) — cofre local, recall, escopos, confidence

## Features válidas

`retrieval`, `packing`, `memoria`, `mcp`, `cli`, `install`

## Por feature

- retrieval → produto, mcp-surface, memoria
- packing → produto, mcp-surface
- memoria → produto, mcp-surface, memoria
- mcp → produto, mcp-surface, memoria
- cli → produto
- install → mcp-surface
