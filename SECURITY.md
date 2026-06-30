# Segurança

Reporte vulnerabilidades de forma privada pelo GitHub Security Advisories do
repositório. Não abra issue pública com exploit, conteúdo indexado ou segredo.

## Modelo

- processamento e persistência são locais
- `.argus/` pertence ao workspace indexado
- `retrieve_handle` só aceita IDs opacos no formato `rh_<16 hex>`
- nenhuma tool executa código do workspace
- paths retornados e lidos devem permanecer confinados ao workspace

Versões suportadas: última minor da série `1.x`.
