---
vault_version: 1
updated: <AAAA-MM-DD>
scope: <frase curta do que o vault cobre>
---

# <Projeto> — índice do vault

<!--
  Ponteiro, não conteúdo. Teto ~100 linhas — ultrapassou, o índice virou conteúdo: refatorar.

  O corpo tem exatamente três seções: Domínios, Features válidas, Por feature.
  Não acrescentar seção nova — cada uma consome teto e nenhuma é lida como ponteiro.

  NUNCA entra aqui:
    - valor vigente de decisão (o valor mora em docs/decisions/)
    - QUALQUER ponteiro para .app-work/ (indexá-lo o torna descobrível e desfaz a separação)
    - listagem de planos, tasks ou sprints
    - cópia de PRD ou de spec

  Remover estes comentários ao instanciar.
-->

## Domínios

<!-- um ponteiro por arquivo de docs/decisions/, com uma linha do que ele cobre -->

- [planos-e-cotas](docs/decisions/planos-e-cotas.md) — cotas, preços e limites dos planos
- [autenticacao](docs/decisions/autenticacao.md) — login, sessão, recuperação de acesso
- [pagamentos](docs/decisions/pagamentos.md) — cobrança, faturas, reembolso

## Features válidas

<!--
  Vocabulário controlado. Slug kebab-case estável, sem versão no nome.
  Tag fora desta lista: adicionar aqui ou recusar a tag.
-->

`login`, `billing`, `dashboard`, `onboarding`

## Por feature

<!--
  Índice reverso DERIVADO dos campos `Afeta:` de docs/decisions/*.md. Nunca escrito à mão.
  Divergiu do `Afeta:`? O `Afeta:` é a verdade; corrigir aqui.

  Exemplo abaixo derivado de:
    planos-e-cotas  Afeta: [login, billing, dashboard]
    autenticacao    Afeta: [login, onboarding]
    pagamentos      Afeta: [billing]
-->

- login → planos-e-cotas, autenticacao
- billing → planos-e-cotas, pagamentos
- dashboard → planos-e-cotas
- onboarding → autenticacao
