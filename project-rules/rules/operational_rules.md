# RULES: OPERATIONAL

## Gates por boundary

| ID | Comando | Gatilho | Resultado esperado |
|---|---|---|---|
| `docs` | `npm run docs:check` | diff em README/COMMANDS/CONTRIBUTING/SECURITY ou no README do pacote | pares EN/pt-BR com link de idioma no cabeçalho (5 linhas; 80 no README do pacote) |
| `typecheck` | `npm run typecheck` | qualquer diff TypeScript | zero erro (`tsc --noEmit`) |
| `test` | `npm test` | qualquer diff de código | vitest verde, incluindo `docs-surface-contract` |
| `lint` | `npm run lint` | qualquer diff de código | eslint sem erro novo |
| `build` | `npm run build` | diff de código ou release | `dist/` gerado sem erro |
| `validate` | `npm run validate` | diff em índice, sync, workspace, memória ou antes de release | `docs:check + typecheck + test + lint + build` em sequência |
| `smoke` | `npm run smoke:package` | antes de publicar | tarball instalável + ListTools slim (5) + CallTool de tool não listada |
| `homologate` | `npm run homologate` | antes de release relevante | ≥2 corpora + jornada MCP golden `homologate-agent-v2` |
| `release:check` | `npm run release:check` | bump de versão | consistência de versão entre os pontos do bump |
| `release:eval` | `npm run release:eval` | antes de release | evidência agregada de memória/privacidade/performance com veredito bloqueante em `.argus/release-evaluation/latest.json` |
| `diff-check` | `git diff HEAD --check` | diff tracked | zero erro de whitespace/patch |

- Diff somente documental/config sem código não aciona gates de análise — mas aciona `docs`.
- Gates estruturais não substituem a análise estática.

## Disciplina de superfície

- `COMMANDS.md` (com par pt-BR) é a referência exaustiva de CLI; mudança de surface exige teste de CLI/MCP **e** atualização de `README.md`/`CHANGELOG.md`.
- Mudança de parsing exige fixture da linguagem afetada (`packages/argus/tests/fixtures`).
- O contrato de docs é verificado por teste: as docs citam as cinco tools listadas, `ARGUS_MCP_TOOLS`, o override `all`, `install --refresh` e rejeitam o ritual de `memory sync` após `remember`; o catálogo permanece 12 registradas / 5 listadas.
- Depois de mudar tools listadas ou agent-rules: `argus install --refresh` e restart do host MCP.

## Distribuição e versão

- Pacote publicado: `@owerride/argus` (`argus` sem escopo é outro pacote).
- Pontos de versão que andam juntos: `package.json` da raiz, `packages/argus/package.json`, `packages/argus/src/version.ts`, `plugins/argus/.codex-plugin/plugin.json`, `plugins/argus/.mcp.json`, `CHANGELOG.md` e `package-lock.json`.
- Não há GitHub Actions: o antigo `ci.yml`/`release.yml` foi removido e os gates rodam localmente. Release só conta como feito com `release:check` + `validate` + `smoke:package` verdes, versão publicada no npm, tag na `main` e GitHub Release com tarball + `SHA256SUMS`.
- Tokens de publicação nunca entram no git.

## Changelog e evidência pública

- `CHANGELOG.md` registra cada release; entradas descrevem o comportamento observável e não regridem claims já corrigidos (ex.: "cinco tools", nunca voltar a "quatro").
- Números de benchmark são limite superior **scriptado**, com método declarado; claim público usa os números vigentes de `reference/benchmark_reference.md` e é revalidado ao tocar no método.

## Código de terceiros

- Proibido copiar código de fonte com licença incompatível. `GitNexus` (PolyForm-Noncommercial-1.0.0) é `clean-room only`; `CodeGraph` (MIT) e `Headroom` (Apache-2.0) entram como referência comportamental com notices.
- Dependências npm preservam suas licenças nos próprios pacotes; a lista vive no lockfile. Detalhes em `reference/third_party_reference.md`.

## Higiene de repositório

- `.argus/`, `dist/`, `dist-release/`, `node_modules/`, `.talos`, `.athena`, `.claude`, `.cursor`, `.codex`, `.agents` e `.hephaestus/` não são versionados.
- O processo em `.app-work/` é local por default: versionam-se apenas `.gitignore`, `INDEX.md`, `roadmap/` e `hephaestus-state.json`.
- `.app-work/.gitignore` (versionado) ignora `references/`, `private/` e `issues/` — repo público: issue carrega contexto interno e histórico público é imutável (D43).

## Autocontenção

- Norma de engenharia deve estar em `AGENTS.md` ou `project-rules/`.
- Regra/referência/contrato estrutural não referencia arquivo externo para completar decisão; spec/PRD pode ser consultada como requisito de produto, nunca como dependência normativa.
- Toda regra, referência e contrato precisa ser alcançável por ao menos um índice.

## Testes

- Teste unit/integração/e2e só é criado/executado quando o usuário pedir explicitamente.
- Analyzer e validadores estruturais são gates, não testes para essa restrição.
- Exceção: o repositório já mantém suíte própria (`npm test`) — rodá-la é gate de validação, não criação de teste novo.
- Teste que apenas cristaliza implementação ruim é anti-padrão; preferir invariante estrutural na origem.

## Falhas e baseline

- Corrigir falha introduzida ou dentro do boundary.
- Falha preexistente externa não autoriza refactor adjacente: registrar comando/evidência, separar baseline e classificar o resultado.
- Não declarar gate verde quando o comando falhou, mesmo que a causa seja baseline.

## Planos/handoffs

- Quando o usuário pedir plano/handoff, propagar os gates aplicáveis no artefato.
- Não copiar gates sem gatilho; cada item informa comando, boundary e critério de aceite.

## Fechamento

- Informar regras aplicadas, comandos executados, resultado e pendências.
- Classificação: `pronto`, `degradado mas utilizável` ou `precisa de follow-up`.
- Commit/push somente por pedido explícito.
