# Protocolo local de decisões

Este arquivo é o contrato operacional entregue com o pacote. Ele é suficiente para manter as decisões sem consultar o kit de origem.

## Fonte de verdade

- A verdade vigente fica somente em `_app-vault/docs/decisions/`. Domínios ativos hoje: `produto`, `mcp-surface`, `memoria`.
- Há um arquivo por domínio de produto, em `kebab-case`.
- `_app-vault/INDEX.md` é mapa: aponta para arquivos e deriva `## Por feature` de `Afeta:`; não copia valores.
- `_app-vault/specs/` é contexto técnico, não fonte de regra.
- `.app-work/` é processo e nunca é insumo de decisão.

## Forma canônica

Cada regra tem um heading próprio:

```markdown
### DEC-001 — Nome da regra

Enunciado vigente da regra.
```

`Afeta: [feature-a, feature-b]` fica logo após o título do domínio. Features usam slugs `kebab-case` do vocabulário do `INDEX.md`.

## Identidade e numeração

- `DEC-NNN` é a identidade estável da regra, não do texto ou do valor atual.
- Antes de criar, inventarie todos os arquivos de `docs/decisions/`, contando headings vivos e IDs em `## Histórico`; o máximo é por projeto, não por domínio. Inventário vazio começa em `DEC-001`.
- Use `max + 1`; nunca reutilize ID removido nem renumere uma decisão existente.
- Para casar uma fonte sem ID, compare domínio, sujeito/objeto, condição/escopo e tipo de regra com os valores variáveis removidos. Se houver duas candidatas igualmente plausíveis, pare e peça confirmação.

## Alteração, adição e remoção

- Antes de contrariar regra vigente, apresentar valor anterior, fonte, novo valor e demais dependências afetadas; obter confirmação humana aplicável. Só então, se o valor mudar, altere o enunciado sob o mesmo `DEC-NNN` e acrescente logo abaixo uma nota: `_Alterado AAAA-MM-DD — era: <valor antigo>. Motivo: <motivo>._`
- Notas novas ficam acima das antigas; mantenha no máximo aproximadamente três.
- Adição sem contradição cria um novo `DEC-NNN`, sem nota de alteração. Novo domínio ou feature exige atualizar `## Domínios`, o vocabulário de features e `## Por feature` no `INDEX.md`; derivar o índice dos campos `Afeta:` na mesma escrita.
- Remoção é rara: antes, procure citações pendentes no repositório inteiro, inclusive `.app-work/`. Citações pendentes devem ser resolvidas antes da remoção; buscar com `rg --hidden` ou paths explícitos, pois `.app-work/` é oculto. Após autorização, remover a cláusula e acrescentar em `## Histórico`: `- AAAA-MM-DD — DEC-NNN removida. Era: <regra antiga>. Motivo: <motivo>.` Esse ID não pode continuar como cláusula viva e não pode ser reutilizado.
- Uma regra que alcança mais de um domínio atualiza todos os arquivos afetados e cita as decisões irmãs nas notas.

## Promoção humana

Texto em guide, brainstorm, PRD ou ledger é candidato de processo, não regra. Só materialize uma decisão quando o usuário confirmar explicitamente o candidato, seu enunciado, domínio e evidência de origem. Sem confirmação, preserve-o como candidato e não o use para governar o produto.

## Separação de territórios

O efeito observável pelo usuário vai para `docs/decisions/`. A norma de implementação vai para `project-rules/` e referencia o `DEC-NNN`; não copie o mesmo valor literal nos dois territórios.
