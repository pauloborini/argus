# INDEX: FEATURE

## Obrigatórias

1. `project-rules/rules/architecture_rules.md`
2. `project-rules/rules/operational_rules.md`

## Sob gatilho

- `domain_rules.md`: envelope de resposta, catálogo de tools, handles, escopo de memória.
- `security_rules.md`: path de workspace, segredo, PII, log ou payload serializado.
- `domain_rules.md` (envelope): caminho de degradação (`parcial`, `stale`, `falha`) ou retry.

Carregar todas as regras acionadas antes da primeira edição, em lotes de até duas.

## Referências

- `reference/mcp_surface_reference.md`: superfície MCP/CLI, ListTools slim e override por env.
