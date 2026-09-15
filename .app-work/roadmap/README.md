# roadmap — fila de promoção

- `ROADMAP.md` — núcleo: decisões de produto transversais + matriz de fatias. Não cresce com o número de fatias além de uma linha de índice cada.
- `slices/M<n>-<slug>.md` — detalhe de cada fatia; o **slice é a autoridade** do estado, a coluna `Estado` da matriz é espelho sincronizado quando `$pack-roadmap` roda.

Regras: roadmap vivo nunca mora em `private/`; marco encerrado vai para `archive/roadmap/<MARCO>_<YYYY-MM>/`.
