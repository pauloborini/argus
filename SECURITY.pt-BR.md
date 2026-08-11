<!-- Idioma: [English](SECURITY.md) · **Português** -->

# Segurança

Reporte vulnerabilidades de forma privada pelo GitHub Security Advisories do
repositório. Não abra issue pública com exploit, conteúdo indexado ou segredo.

## Modelo

- Processamento e persistência são locais.
- `.argus/` pertence ao workspace indexado.
- `retrieve_handle` só aceita IDs opacos no formato `rh_<16 hex>`.
- Nenhuma tool executa código do workspace.
- Paths retornados e lidos devem permanecer confinados ao workspace.

Versões suportadas: a última minor da linha major atual `2.x`.
