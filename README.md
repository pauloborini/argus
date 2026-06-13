# Atlas Cortex

Local code retrieval and context packing for coding agents. Runtime `1.0.0`,
local-first, sem UI, com CLI e MCP.

## Requisitos

- Node.js >= 20
- npm (workspaces)

## Instalação

Via npm:

```bash
npm install -g atlas-cortex
cortex --version
```

Via `npx`, sem instalação global:

```bash
npx atlas-cortex init
npx atlas-cortex index
```

Para desenvolver o monorepo:

```bash
npm ci
npm run validate
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
cortex retrieve rh_0123456789abcdef
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
`cortex pack-context` monta pacote curto com refs e handle opcional.
`cortex retrieve` recupera explicitamente o original persistido no mesmo workspace.

### 3. Servidor MCP

Configure seu agente/IDE para MCP stdio:

```json
{
  "mcpServers": {
    "atlas-cortex": {
      "command": "npx",
      "args": ["-y", "atlas-cortex@1.0.0", "serve", "--mcp"]
    }
  }
}
```

O servidor expõe nove tools: `search`, `explore`, `trace`, `impact`,
`diff_impact`, `files`, `pack_context`, `retrieve`, `status`.

Todas leem estado local. Respostas incluem `state`, `confidence`, limitações e
staleness quando aplicável. `retrieve` aceita apenas handles opacos locais.

## Plugin Codex

O marketplace do repositório vive em `.agents/plugins/marketplace.json`.
Após o repositório estar público:

```bash
codex plugin marketplace add https://github.com/pauloborini/atlas-cortex
codex plugin install atlas-cortex@atlas-cortex
```

O plugin sobe o MCP via pacote npm versionado. Manifest:
`plugins/atlas-cortex/.codex-plugin/plugin.json`.

## Scripts de desenvolvimento

Na raiz do monorepo:

```bash
npm run build      # compila packages/cortex
npm run benchmark:mvp  # executa benchmark interno S16
npm run test       # testes unitários (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run smoke:package  # instala e exercita o tarball em diretório limpo
npm run homologate     # valida repos externos locais
```

O benchmark escreve evidência em `.atlas/benchmark/latest/`:

- `summary.json` — resultado agregado machine-readable
- `SUMMARY.md` — leitura humana do benchmark
- `BT-01-*.md` ... `BT-06-*.md` — detalhe bruto por task/arm

## Release

Fluxo mínimo para adoção interna do MVP:

```bash
npm ci
npm run validate
npm run smoke:package
npm run benchmark:mvp
npm run homologate
npm run release:check
```

Tags `v*` executam CI, smoke do tarball, publicação npm com provenance e
GitHub Release com `SHA256SUMS`. A versão da tag deve coincidir com root,
runtime e plugin.

Pré-requisitos para a primeira publicação:

1. tornar `pauloborini/atlas-cortex` público
2. configurar trusted publisher no npm para `.github/workflows/release.yml`
3. criar e enviar a tag `v1.0.0`

### Upgrade

Use versão explícita para manter a instalação reproduzível:

```bash
npm install -g atlas-cortex@1.0.0
cortex --version
```

Atualize o plugin e a configuração MCP para a mesma versão antes de publicar
uma nova tag SemVer. Execute `cortex sync`; se houver mudança incompatível de
schema ou falha de leitura, execute `cortex index` para reconstrução completa.

### Rollback

Reinstale a última versão conhecida e restaure a referência versionada no MCP:

```bash
npm install -g atlas-cortex@<versao-anterior>
cortex --version
cortex index
```

Não reutilize `.cortex/index.db` quando a versão anterior não reconhecer o
schema. Remova somente `.cortex/index.db` e rode `cortex index`; os arquivos do
projeto não são alterados.

### Recovery

- índice stale: `cortex sync`
- índice ausente ou corrompido: remova `.cortex/index.db` e rode `cortex index`
- workspace inválido: preserve o código, remova `.cortex/`, rode `cortex init`
  e depois `cortex index`
- handle corrompido: gere novamente o pacote com `cortex pack-context`; não
  edite manifests em `.cortex/packed-handles`

Critério de GO:

- redução de tool calls >= 35%
- redução de tokens >= 25%
- utilidade média >= 4/5
- nenhuma task atlas-cortex abaixo de 3/5

Resultado mais recente do benchmark S16:

- tool calls: `24 -> 14` (`-41,7%`)
- tokens aproximados: `76209 -> 8919` (`-88,3%`)
- utilidade média atlas-cortex: `4,17/5`
- menor utilidade atlas-cortex: `4/5`

## Limitações conhecidas

- chamadas sem import resolvido degradam para correspondência global por nome
- Dart/Kotlin mantêm cobertura parcial explícita
- resolução dinâmica/reflexiva não é tratada como causalidade comprovada
- `search` combina ranking lexical/estrutural; não usa embeddings

## Contratos de referência

- `.atlas/contracts/SURFACE_MCP_CLI.md` — surface congelada
- `.atlas/contracts/ESTADOS_RESPOSTA.md` — estados operacionais
- `.atlas/contracts/CONTRATO_MVP.md` — contrato MVP
