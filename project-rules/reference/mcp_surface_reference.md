# REFERENCE: MCP / CLI SURFACE

Catálogo consultável da superfície. Acionado por `index/contract.md`, `index/feature.md` e `index/diagnostic.md`.

## Catálogo registrado (12)

| Tool | Papel | Listada por default |
|---|---|---|
| `explore` | contexto estrutural de símbolo, arquivo ou tema | sim |
| `pack_context` | empacotar múltiplas fontes sob budget, com handles | sim |
| `recall` | busca no cofre de memória, sem LLM | sim |
| `remember` | capturar nota, decisão ou insight no cofre | sim |
| `status` | saúde, staleness e modo slim da superfície | sim |
| `search` | busca lexical/estrutural de símbolos | não (CallTool/CLI) |
| `trace` | fluxo entre pontos indexados | não |
| `impact` | blast radius de símbolo/arquivo/mudança | não |
| `diff_impact` | impacto do diff atual (unstaged/staged/all/compare) | não |
| `files` | árvore indexada sem scanner bruto | não |
| `retrieve` | reidratar handle `rh_*`/`mh_*` | não |
| `semantic_search` | busca semântica/híbrida (embeddings opcionais) | não |

Ordem do ListTools default: `explore`, `pack_context`, `recall`, `remember`, `status`. `ARGUS_MCP_TOOLS=all` (ou CSV) abre o catálogo; env inválida/vazia cai no default. Mudar env exige restart do host, que costuma cachear ListTools.

## Contrato de docs (verificado por teste)

O teste de contrato da superfície exige que `README.md`, `README.pt-BR.md`, `COMMANDS.md` e `COMMANDS.pt-BR.md` citem as cinco tools listadas, a variável `ARGUS_MCP_TOOLS` e o override `all`; que o `CHANGELOG.md` registre a surface slim ("cinco tools") e não regrida para quatro, além de mencionar CallTool/restart; que `COMMANDS` documente `install --refresh`; e que os READMEs rejeitem explicitamente `memory sync` após `remember`. O mesmo teste fixa `MCP_TOOL_NAMES` em 12 e `DEFAULT_LISTED_MCP_TOOLS` em 5.

## Fallback e path feliz

- MCP indisponível: `argus explore`, `argus pack-context`, `argus memory search`, `argus memory remember`, `argus status`.
- `explore`/`pack_context` em estilo balanced devolvem trechos verbatim acionáveis; truncamento por cap emite `retrieve_handle`.
- O bloco de agent-rules do host (`argus agent-rules install`) é **gerado** pelo produto, com marcador de versão `argus-agent-rules-version: 2`; refresh é `argus install --refresh`. O bloco do próprio repositório (`packages/argus/AGENTS.md` e `CLAUDE.md`) é dogfooding verificado por teste — não replicar à mão.
