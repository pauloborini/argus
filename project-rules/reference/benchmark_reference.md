# REFERENCE: BENCHMARK

Evidência pública: `docs/benchmark/SUMMARY.md`. Acionado por `index/refactoring.md` (mudança no volume de contexto entregue).

## Números vigentes

| Métrica (baseline → argus) | Resultado |
|---|---|
| Tokens aproximados | **−94,9%** |
| Tool calls | **−11,8%** |
| Ground-truth respondido (braço argus) | **6/6** |
| Cirúrgica (tokens) | **−98,8%** |
| Varredura (tokens) | **−53,0%** |
| Ganho de formato isolado | **~0%** |

Totais por braço: baseline 17 chamadas / 245.195 tokens; formato-só 17 / 245.195; argus 15 / 12.472.

## Método

- Braços: baseline (leitura crua de arquivos) → formato-só (mesma informação, serialização compacta) → argus (tools reais).
- Tokens: heurística subword offline (`approxTokens`) — aproximação, não o tokenizer do modelo alvo.
- Utilidade: checagem objetiva contra ground-truth (mustCite + símbolo nas saídas reais), com incerteza declarada por task.
- 6 tarefas reais de engenharia (BT-01..BT-06), perfil cirúrgica × varredura reportado separado.
- O ganho de formato ≈ 0 é resultado, não bug: sob contador subword, disciplina de serialização custa ~0; todo o ganho vem do índice entregar menos conteúdo.

## Regra de claim

- Os números são **limite superior interno scriptado** (sem agente vivo). Nunca apresentar como medição de agente real.
- Ao tocar o método, revalidar e atualizar `docs/benchmark/SUMMARY.md`, o README EN/pt-BR e o `CHANGELOG.md` na mesma mudança.
- Reivindicação de "churn LLM" é proibida: a homologação de agente não mede churn.
