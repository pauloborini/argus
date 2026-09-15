# <Domínio>

<!--
  Um arquivo por DOMÍNIO DE PRODUTO — área que o usuário final reconhece.
  Não por feature, tela, sprint ou data. Não um arquivo por decisão.

  Nome do arquivo: docs/decisions/<dominio>.md, kebab-case.
  Ex.: planos-e-cotas.md, autenticacao.md, pagamentos.md.

  Remover estes comentários ao instanciar.
-->

Afeta: [login, billing, dashboard]

<!--
  `Afeta:` vai logo após o título, acima da primeira cláusula.
  Features em kebab-case, do vocabulário declarado no INDEX.md.
  É o insumo de `## Por feature` — o índice é derivado daqui, não o contrário.
-->

### DEC-016 — Cota de export do plano gratuito

Plano gratuito: 20 exports/mês.

_Alterado 2026-08-05 — era: 10/mês. Motivo: feedback do piloto._

### DEC-021 — Cortesia do plano anual

Plano anual inclui 2 meses de cortesia.

<!--
  ─────────────────────────────────────────────────────────────────────────
  REGRAS DE ESCRITA (resumo; contrato entregue em
  _app-vault/docs/TEMPLATES/DECISION_PROTOCOL.md)

  ÂNCORA
    Cada regra tem heading próprio: `### DEC-NNN — <regra>`, ID colado ao enunciado.
    Ancorar o arquivo inteiro não vale: "conforme DEC-016" precisa ser verificável.

  IN-PLACE
    Decisão não é substituída por outra decisão. O valor muda, a DEC-NNN permanece.
    Não existe DEC aposentada por DEC mais nova.

  NUMERAÇÃO
    Sequencial POR PROJETO: max(existing) + 1, sobre docs/decisions/ — cláusulas vivas
    E IDs listados em `## Histórico`. Nunca reusar número, inclusive de decisão removida.
    Nunca prefixar por domínio (DEC-PAG-001).

  NOTA INLINE (só em alteração)
    Uma linha, logo abaixo do enunciado:
      _Alterado <data> — era: <valor antigo>. Motivo: <motivo>._
    O ID não se repete — já está no heading.
    Notas novas empilham ACIMA da anterior.
    Passou de ~3 notas na cláusula: as antigas são APAGADAS (não arquivadas).

  ADIÇÃO
    Cláusula nova que não contraria nada: DEC-NNN novo, SEM alerta e SEM nota.
    Trouxe domínio novo ou tag `Afeta:` nova: atualizar o INDEX.md no mesmo fluxo
    (## Domínios, lista de features válidas, ## Por feature).

  CROSS-DOMÍNIO
    Citar a DEC irmã dentro da nota de cada arquivo tocado:
      _Alterado 2026-08-05 — era: R$ 99/ano. Motivo: reajuste; ver DEC-024 em pagamentos.md._

  REMOÇÃO (rara)
    Procurar citações pendentes do ID antes (inclusive em .app-work/, que exige --hidden).
    Registrar em `## Histórico` no fim do arquivo — a única seção de histórico que existe.
  O arquivo DECISION_PROTOCOL.md materializado no pacote é a referência
  operacional completa. Este comentário é removido ao instanciar o template.
  ─────────────────────────────────────────────────────────────────────────
-->

## Histórico

<!--
  Só existe se houve REMOÇÃO. Uma linha por remoção. Alteração NÃO entra aqui —
  alteração vira nota inline sob a cláusula.
  Se nunca houve remoção neste domínio, apagar esta seção inteira.
  O ID citado aqui NÃO pode existir como cláusula acima — se existe, não foi removido.
-->

- 2026-08-05 — DEC-009 removida. Era: teto de 3 projetos no plano gratuito. Motivo: limite abolido.
