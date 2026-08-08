# Benchmark interno — Argus (item 21, honesto)

Gerado em: 2026-08-08T17:07:02.036Z

> **LIMITE SUPERIOR INTERNO SCRIPTADO (sem agente vivo; tokens por heurística aproximada).**

## Headline (qualificado)

- Tokens baseline → argus: −94.9% (headline honesto)
- Tool calls baseline → argus: −11.8%

### Decomposição formato vs índice

- Ganho de **formato** (baseline → formato-só): ~0%
- Ganho de **índice** (formato-só → argus): −94.9%

## Totais por arm

| Arm | Tool calls | Tokens | Corretos | Incerteza declarada |
|---|---|---|---|---|
| baseline | 17 | 245195 | 6/6 | 6/6 |
| formato-so | 17 | 245195 | 6/6 | 6/6 |
| argus | 15 | 12472 | 6/6 | 6/6 |

## Perfil cirúrgica × varredura (tokens)

| Kind | Baseline | Formato-só | Argus | Headline | Ganho índice |
|---|---|---|---|---|---|
| cirurgica | 224495 | 224495 | 2753 | −98.8% | −98.8% |
| varredura | 20700 | 20700 | 9719 | −53.0% | −53.0% |

## Por task

| Task | Arm | Tool calls | Tokens | Correto | Incerteza |
|---|---|---|---|---|---|
| BT-01 | baseline | 3 | 74902 | ✓ | ✓ |
| BT-01 | formato-so | 3 | 74902 | ✓ | ✓ |
| BT-01 | argus | 3 | 1641 | ✓ | ✓ |
| BT-02 | baseline | 3 | 88567 | ✓ | ✓ |
| BT-02 | formato-so | 3 | 88567 | ✓ | ✓ |
| BT-02 | argus | 2 | 402 | ✓ | ✓ |
| BT-03 | baseline | 3 | 4835 | ✓ | ✓ |
| BT-03 | formato-so | 3 | 4835 | ✓ | ✓ |
| BT-03 | argus | 3 | 1831 | ✓ | ✓ |
| BT-04 | baseline | 3 | 3549 | ✓ | ✓ |
| BT-04 | formato-so | 3 | 3549 | ✓ | ✓ |
| BT-04 | argus | 3 | 2361 | ✓ | ✓ |
| BT-05 | baseline | 2 | 61026 | ✓ | ✓ |
| BT-05 | formato-so | 2 | 61026 | ✓ | ✓ |
| BT-05 | argus | 2 | 710 | ✓ | ✓ |
| BT-06 | baseline | 3 | 12316 | ✓ | ✓ |
| BT-06 | formato-so | 3 | 12316 | ✓ | ✓ |
| BT-06 | argus | 2 | 5527 | ✓ | ✓ |

Gate: PASS (índice surfa ground-truth em toda task + headline positivo)

## Metodologia

- **Tokens**: Heurística subword offline (approxTokens) — APROXIMAÇÃO, não o tokenizer do modelo alvo.
- **Arms**: baseline (file reads crus) → formato-so (mesma info, serialização compacta) → argus (tools reais concise).
- **Utilidade**: Checagem objetiva contra ground-truth (mustCite + símbolo nas saídas REAIS); uncertainty medido.
- **Agente vivo**: NÃO implementado — números são scriptados. Hook runLiveAgent reservado para follow-up.
- **formato-só é arm sintético construído**: aplica `compactSerialize` ao conteúdo do baseline (mesma informação), aproximando a disciplina de serialização do envelope `concise`.
- **Ground-truth por task**: arquivos/símbolo corretos verificados como substring nas saídas reais — não em prosa do autor.
- **Por que o ganho de formato ≈ 0**: sob um contador subword, disciplina de serialização (indentação, linhas em branco) custa ~0 token — whitespace praticamente não tokeniza. Todo o ganho vem de o índice entregar MENOS conteúdo (ranges/handles em vez de arquivos inteiros), não de reformatar. É um resultado honesto, não um bug.
- O perfil cirúrgica×varredura é reportado separado: o índice ganha mais em lookup pontual; em varredura ampla o ganho é menor.
