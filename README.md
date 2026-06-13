# Atlas Cortex

Motor local de code retrieval e context packing para agentes — MVP sem UI.

## Requisitos

- Node.js >= 20
- npm (workspaces)

## Instalação

```bash
npm install
npm run build
```

Para usar a CLI globalmente em desenvolvimento:

```bash
cd packages/cortex && npm link
```

## Uso rápido

### 1. Preparar workspace

```bash
cortex init
```

Cria metadados em `.cortex/` no repositório alvo:

- `.cortex/workspace.json` — metadados do workspace (S03)
- `.cortex/file-manifest.json` — fingerprint de arquivos (S04+)

Reexecução é idempotente (aviso se já preparado). JSON corrompido retorna erro orientado.

### 2. Comandos lifecycle e discovery (operacional S17)

```bash
cortex index   # full rebuild do manifest + índice SQLite local
cortex sync    # atualização incremental (delta) no manifest + SQLite
cortex status  # saúde/staleness do índice local
cortex search "MinhaFuncao"   # busca lexical de símbolos via FTS
cortex files --pattern src    # estrutura indexada com filtros simples
cortex explore "MinhaFuncao" --mode symbol   # contexto estrutural composto
cortex trace --from MinhaFuncao --to OutraFuncao   # fluxo provável com incerteza explícita
cortex impact MinhaFuncao --direction dependents   # blast radius provável com risco resumido
cortex diff-impact --scope all   # impacto provável do diff Git atual
cortex pack-context --sources utils.ts --goal "entender refactor" --token-budget 400
cortex serve --mcp   # sobe servidor MCP stdio
```

Sem workspace inicializado, `index`, `sync` e `serve --mcp` falham com orientação para rodar `init`.

Sem manifest prévio, `sync` falha com `E_INDEX_MISSING` orientando executar `cortex index`.
`cortex index` e `cortex sync` mantêm:

- `.cortex/file-manifest.json` — inventário/fingerprint
- `.cortex/index.db` — fonte de verdade estrutural em SQLite + FTS

`cortex status` espelha saúde do índice via CLI com `fresh`/`stale`/`unknown`, `storage_backend=sqlite` e `schema_version`.
`cortex search` retorna candidatos lexicais indexados com estados honestos (`sucesso`, `ambigua`, `stale`, `falha`).
`cortex files` retorna a estrutura indexada com `symbol_counts`, além de `--pattern` e `--max-depth`.
`cortex explore` combina alvo, símbolos centrais, imports, arquivos relevantes e snippets por faixa de linha.
`cortex trace` devolve caminhos prováveis entre símbolos/arquivos com `paths`, `files`, `symbols` e `uncertainty_points`.
`cortex impact` estima blast radius por símbolo/arquivo com `direct_affected`, `indirect_affected`, `files`, `tests` e `risk_summary`.
`cortex diff-impact` lê o diff Git real e retorna `changed_files`, `changed_symbols`, `affected_areas`, `affected_tests` e `risk_summary`.
`cortex pack-context` monta um pacote curto com `packed_context`, `origin_refs`, `removed_or_summarized`, `retrieve_handle` opcional, `token_estimate` e `reversibility` real.

### 3. Servidor MCP

Configure seu agente/IDE para MCP stdio:

```json
{
  "mcpServers": {
    "atlas-cortex": {
      "command": "cortex",
      "args": ["serve", "--mcp"]
    }
  }
}
```

O servidor expõe **exatamente oito tools** congeladas na S02: `search`, `explore`, `trace`, `impact`, `diff_impact`, `files`, `pack_context`, `status`.

Respostas de retrieval permanecem **stubs honestos**: campos vazios + `state` explícito, sem dados fictícios plausíveis.
`status`, `files`, `search`, `explore`, `trace`, `impact`, `diff_impact` e `pack_context` já leem o índice SQLite local.

## Scripts de desenvolvimento

Na raiz do monorepo:

```bash
npm run build      # compila packages/cortex
npm run benchmark:mvp  # executa benchmark interno S16
npm run test       # testes unitários (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

O benchmark escreve evidência em `.atlas/benchmark/latest/`:

- `summary.json` — resultado agregado machine-readable
- `SUMMARY.md` — leitura humana do benchmark
- `BT-01-*.md` ... `BT-06-*.md` — detalhe bruto por task/arm

## Rollout interno

Fluxo mínimo para adoção interna do MVP:

```bash
npm install
npm run build
npm run test
npm run lint
npm run typecheck
npm run benchmark:mvp
```

Critério de GO interno atual:

- redução de tool calls >= 35%
- redução de tokens >= 25%
- utilidade média >= 4/5
- nenhuma task atlas-cortex abaixo de 3/5

Resultado mais recente do benchmark S16:

- tool calls: `24 -> 14` (`-41,7%`)
- tokens aproximados: `76209 -> 8919` (`-88,3%`)
- utilidade média atlas-cortex: `4,17/5`
- menor utilidade atlas-cortex: `4/5`

## Limitações atuais (pós-S17)

- `trace` v1 ainda usa inferência estrutural por arquivo/nome em parte das chamadas
- `impact` v1 ainda usa o mesmo grafo estrutural do `trace`; não prova causalidade semântica profunda
- `diff_impact` v1 trabalha por arquivo e blast radius estrutural; não interpreta hunks finos por símbolo
- `pack_context` reidrata via `sources[]` com reversibilidade real, mas ainda não existe tool pública dedicada de retrieve fora da surface congelada
- `search` atual é lexical/FTS e não faz retrieval semântico composto

## Contratos de referência

- `.atlas/contracts/SURFACE_MCP_CLI.md` — surface congelada
- `.atlas/contracts/ESTADOS_RESPOSTA.md` — estados operacionais
- `.atlas/contracts/CONTRATO_MVP.md` — contrato MVP
