# Memória

Afeta: [memoria, mcp, retrieval]

### DEC-019 — Memória é cofre local, não platform

Cofre de projeto/agente local. Não vira Mem0/Zep SaaS. Ingestão verbatim de sessão inteira não é obrigatória no caminho crítico; não substitui o índice de código.

### DEC-020 — Remember recallável sem sync manual

Após `remember`, o fato é recuperável por `recall` na mesma sessão sem `memory sync` wipe/rebuild no happy path.

### DEC-021 — Ranking de recall com vigência

Ranking de `recall` usa confidence, stale/contradiction e recência — fato supersedido não compete como vigente; stale/contradiction não aparecem como certeza plena.

### DEC-022 — Escopos de gravação

Todo fato v2 pertence a exatamente um escopo ativo (`project`, `user`, `session`, `agent`). Escopo `org` é rejeitado na gravação.

### DEC-023 — Captura de decisão → confidence confirmed

No path de captura de decisão (`remember` com conteúdo/tipo de decisão), gravar `confidence: confirmed`. Inbox genérico pode permanecer `presumed`.
