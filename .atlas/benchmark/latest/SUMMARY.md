# Benchmark interno — Atlas Cortex (item 21, honesto)

Gerado em: 2026-06-17T15:53:18.537Z

> **LIMITE SUPERIOR INTERNO SCRIPTADO (sem agente vivo; tokens por heurística aproximada).**

## Headline (qualificado)

- Tokens baseline → atlas: −92.8% (headline honesto)
- Tool calls baseline → atlas: −11.8%

### Decomposição formato vs índice

- Ganho de **formato** (baseline → formato-só): ~0%
- Ganho de **índice** (formato-só → atlas): −92.8%

## Totais por arm

| Arm | Tool calls | Tokens | Corretos | Incerteza declarada |
|---|---|---|---|---|
| baseline | 17 | 153157 | 6/6 | 6/6 |
| formato-so | 17 | 153157 | 6/6 | 6/6 |
| atlas | 15 | 11098 | 6/6 | 6/6 |

## Perfil cirúrgica × varredura (tokens)

| Kind | Baseline | Formato-só | Atlas | Headline | Ganho índice |
|---|---|---|---|---|---|
| cirurgica | 134680 | 134680 | 2915 | −97.8% | −97.8% |
| varredura | 18477 | 18477 | 8183 | −55.7% | −55.7% |

## Por task

| Task | Arm | Tool calls | Tokens | Correto | Incerteza |
|---|---|---|---|---|---|
| BT-01 | baseline | 3 | 52915 | ✓ | ✓ |
| BT-01 | formato-so | 3 | 52915 | ✓ | ✓ |
| BT-01 | atlas | 3 | 1807 | ✓ | ✓ |
| BT-02 | baseline | 3 | 53947 | ✓ | ✓ |
| BT-02 | formato-so | 3 | 53947 | ✓ | ✓ |
| BT-02 | atlas | 2 | 398 | ✓ | ✓ |
| BT-03 | baseline | 3 | 3988 | ✓ | ✓ |
| BT-03 | formato-so | 3 | 3988 | ✓ | ✓ |
| BT-03 | atlas | 3 | 1503 | ✓ | ✓ |
| BT-04 | baseline | 3 | 3478 | ✓ | ✓ |
| BT-04 | formato-so | 3 | 3478 | ✓ | ✓ |
| BT-04 | atlas | 3 | 2148 | ✓ | ✓ |
| BT-05 | baseline | 2 | 27818 | ✓ | ✓ |
| BT-05 | formato-so | 2 | 27818 | ✓ | ✓ |
| BT-05 | atlas | 2 | 710 | ✓ | ✓ |
| BT-06 | baseline | 3 | 11011 | ✓ | ✓ |
| BT-06 | formato-so | 3 | 11011 | ✓ | ✓ |
| BT-06 | atlas | 2 | 4532 | ✓ | ✓ |

Gate: PASS (índice surfa ground-truth em toda task + headline positivo)

## Metodologia

- **Tokens**: Heurística subword offline (approxTokens) — APROXIMAÇÃO, não o tokenizer do modelo alvo.
- **Arms**: baseline (file reads crus) → formato-so (mesma info, serialização compacta) → atlas (tools reais concise).
- **Utilidade**: Checagem objetiva contra ground-truth (mustCite + símbolo nas saídas REAIS); uncertainty medido.
- **Agente vivo**: NÃO implementado — números são scriptados. Hook runLiveAgent reservado para follow-up.
- **formato-só é arm sintético construído**: aplica `compactSerialize` ao conteúdo do baseline (mesma informação), aproximando a disciplina de serialização do envelope `concise`.
- **Ground-truth por task**: arquivos/símbolo corretos verificados como substring nas saídas reais — não em prosa do autor.
- **Por que o ganho de formato ≈ 0**: sob um contador subword, disciplina de serialização (indentação, linhas em branco) custa ~0 token — whitespace praticamente não tokeniza. Todo o ganho vem de o índice entregar MENOS conteúdo (ranges/handles em vez de arquivos inteiros), não de reformatar. É um resultado honesto, não um bug.
- O perfil cirúrgica×varredura é reportado separado: o índice ganha mais em lookup pontual; em varredura ampla o ganho é menor.
