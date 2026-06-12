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

### 2. Comandos lifecycle (operacional S06)

```bash
cortex index   # full rebuild do manifest + índice SQLite local
cortex sync    # atualização incremental (delta) no manifest + SQLite
cortex status  # saúde/staleness do índice local
cortex serve --mcp   # sobe servidor MCP stdio
```

Sem workspace inicializado, `index`, `sync` e `serve --mcp` falham com orientação para rodar `init`.

Sem manifest prévio, `sync` falha com `E_INDEX_MISSING` orientando executar `cortex index`.
`cortex index` e `cortex sync` mantêm:

- `.cortex/file-manifest.json` — inventário/fingerprint
- `.cortex/index.db` — fonte de verdade estrutural em SQLite + FTS

`cortex status` espelha saúde do índice via CLI com `fresh`/`stale`/`unknown`, `storage_backend=sqlite` e `schema_version`.

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
`status` e `files` já leem o índice SQLite local.
`search`, `explore`, `trace`, `impact`, `diff_impact` e `pack_context` ainda degradam honestamente conforme contrato do MVP.

## Scripts de desenvolvimento

Na raiz do monorepo:

```bash
npm run build      # compila packages/cortex
npm run test       # testes unitários (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## Limitações atuais (pós-S06)

- Sem `search` rankeado útil para o agente (S08)
- Sem `explore`/`trace`/`impact`/`diff_impact` úteis (S09+)
- Sem `pack_context` funcional com retrieve handle (S13/S14)
- Tools MCP retornam payloads stub alinhados a `.atlas/contracts/ESTADOS_RESPOSTA.md`

## Contratos de referência

- `.atlas/contracts/SURFACE_MCP_CLI.md` — surface congelada
- `.atlas/contracts/ESTADOS_RESPOSTA.md` — estados operacionais
- `.atlas/contracts/CONTRATO_MVP.md` — contrato MVP
