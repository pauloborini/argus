# RULES: DOMAIN

## Papel

Definir o contrato de dados do produto: envelope de resposta, catálogo de tools, handles e fatos de memória.

## Envelope de resposta

Toda tool devolve o mesmo envelope de honestidade:

- `state`: `sucesso` (limpo), `ambigua` (múltiplos matches equivalentes), `parcial` (cobertura parcial ou staleness incerta), `stale` (índice atrás do código), `falha` (não responde).
- `confidence`: `high` | `medium` | `low`.
- `limitations` e `staleness_hint` quando algo pode estar defasado, com a ação esperada (ex.: rodar `argus sync`).

Regra: staleness nunca é silencioso e `parcial` é raro e acionável, não default cosmético. Nenhuma tool apresenta stale/contradição vigente como certeza plena.

## Superfície

- Catálogo registrado: 12 tools (10 de código + `remember` + `recall`); CallTool aceita o catálogo completo.
- ListTools default é slim: `explore`, `pack_context`, `recall`, `remember`, `status`, nessa ordem, salvo `ARGUS_MCP_TOOLS` explícito (`all` ou allowlist CSV); env inválida ou vazia cai no default e **nunca** abre as 12 em silêncio.
- `retrieve` permanece fora do default e continua válido via CallTool/CLI.
- Síntese LLM (`think`), `dream`, `doctor` e `rebuild` não são tools MCP públicas: vivem em CLI/flag interna.
- O path feliz conta uma história só: quase tudo → `explore`; decisão → `remember`/`recall`; multi-fonte/budget → `pack_context`.

## Handles

- Formato opaco: `rh_<16 hex>` para código, `mh_<16 hex>` para memória, no mesmo store `.argus/packed-handles/`.
- Handle é o caminho de reversibilidade: compressão forte guarda o original e `retrieve` reidrata sem releitura do filesystem.
- Handle inválido é `falha`, nunca tentativa de resolver path.

## Memória v2

- Todo fato pertence a exatamente um escopo ativo (`project`, `user`, `session`, `agent`); `org` e escopo desconhecido são rejeitados na gravação.
- `source` é obrigatória; `confidence` ausente assume o nível mais conservador (`presumed`), e captura de decisão via `remember` grava `confirmed`.
- Supersedência não apaga origem; leitura prefere o vigente, e fatos supersedidos continuam recuperáveis para auditoria.
- O hot path de `remember` **nunca** chama `memory sync`: projeção FTS + embed incremental da nota; se o embedding ficar pendente, o hint é `argus memory embed`.
- Valores literais (escopos, pesos de ranking, limites) moram em `_app-vault/specs/MEMORY_V2_CONTRACT.md` e nas decisões `DEC-019` a `DEC-023`; esta regra **referencia**, não copia.

## Enriquecimento código↔memória

`explore`, `semantic_search` e `pack_context` podem anexar ou fundir o cofre internamente; o agente não orquestra código vs memória na maioria dos casos (DEC-014).

## Invariantes verificáveis

- `MCP_TOOL_NAMES` tem 12 nomes e `DEFAULT_LISTED_MCP_TOOLS` tem 5 (teste de contrato).
- Docs de superfície não podem contradizer o catálogo.
