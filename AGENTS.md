## Produto — decisões vigentes

Vault: `_app-vault/`. Mapa: `_app-vault/INDEX.md`.
Fonte de verdade: `_app-vault/docs/decisions/<dominio>.md` — cada regra sob `### DEC-NNN`.

Domínios deste projeto:

- `produto` — tese, identidade, honestidade, egress, precedência
- `mcp-surface` — catálogo MCP, ListTools slim, Athena, `.argus/`
- `memoria` — cofre local, recall, escopos, confidence

Regra de produto citada em qualquer outro lugar e ausente de `docs/decisions/` **não é regra** —
é lacuna a promover.

## Código — normas de implementação

Normas ao codar: `project-rules/rules/*` (pasta ainda não criada neste repo — ao surgir, entra
aqui sem copiar valor de produto).

Caso híbrido (a regra afeta o usuário **e** é validação de código): o **efeito observável pelo
usuário final** mora em `_app-vault/docs/decisions/`; a **norma de como implementar** mora em
`project-rules/`. `project-rules/` **referencia** a `DEC-NNN` — nunca copia o valor.
