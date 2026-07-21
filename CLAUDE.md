<!-- >>> argus >>> -->
## Argus

<!-- argus-agent-rules-version: 2 -->

Este repositório tem um índice local Argus (`.argus/`). Antes de varrer
o código com grep/leitura repetida, prefira as tools do path feliz
(listadas por default no MCP — as mesmas de ListTools slim): `explore`, `pack_context`, `recall`, `remember`, `status`.

Decisão operacional:

1. `explore` — primeira escolha para entender símbolo, arquivo ou tema.
2. `pack_context` — reunir múltiplas fontes (código + memória) sob budget.
3. `recall` — recuperar decisões/regras já capturadas; use antes de inventar regra de projeto.
4. `remember` — ao fechar uma decisão ou insight, capture no cofre
   (MCP `remember` ou CLI `argus memory remember`).
5. `status` — saúde, staleness e modo slim da surface MCP.

Fallback CLI (quando o MCP não estiver disponível): `argus explore`,
`argus pack-context`, `argus memory search` (equiv. recall),
`argus memory remember`, `argus status`.

Memória local no mesmo estado `.argus/`:

- `remember` / `recall` — captura e busca no cofre sem LLM.
- `pack_context` aceita código + memória; prefira um pacote a várias leituras.

Tools avançadas (`search`, `trace`, `impact`, `diff_impact`, `files`,
`retrieve`, `semantic_search`) continuam invocáveis via CallTool
ou CLI mesmo quando não listadas. Para ListTools completo:
`ARGUS_MCP_TOOLS=all` (exige restart do MCP).

O índice é mantido fresco automaticamente: hooks git marcam mudanças e o
servidor MCP roda sync incremental antes de responder. Não é preciso rodar
`argus sync` manualmente no fluxo normal. Se um resultado vier com
`state: parcial` e `staleness_hint`, rode `argus sync` e repita.
<!-- <<< argus <<< -->
