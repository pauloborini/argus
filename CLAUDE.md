<!-- >>> argus >>> -->
## Argus

Este repositório tem um índice local Argus (`.argus/`). Antes de varrer
o código com grep/leitura repetida, use as tools do argus — elas respondem
perguntas estruturais a partir do índice:

- `search` — achar símbolo por nome.
- `explore` — contexto estrutural de símbolo/arquivo/tema.
- `trace` / `impact` / `diff_impact` — fluxo, raio de impacto e impacto do diff.
- `files` — estrutura indexada.
- `pack_context` / `retrieve` — empacotar e reidratar contexto.
- `status` — saúde e staleness do índice.

O índice é mantido fresco automaticamente: hooks git marcam mudanças e o
servidor MCP roda sync incremental antes de responder. Não é preciso rodar
`argus sync` manualmente no fluxo normal. Se um resultado vier com
`state: parcial` e `staleness_hint`, rode `argus sync` e repita.
<!-- <<< argus <<< -->
