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

Cria metadados em `.cortex/` no repositório alvo. Reexecução é idempotente (aviso se já preparado).

### 2. Comandos lifecycle (stubs S03)

```bash
cortex index   # indisponível até S04 — exit != 0
cortex sync    # indisponível até S04 — exit != 0
cortex serve --mcp   # sobe servidor MCP stdio
```

Sem workspace inicializado, `index`, `sync` e `serve --mcp` falham com orientação para rodar `init`.

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

Respostas são **stubs honestos**: campos vazios + `state` explícito (`parcial` ou `falha`), sem dados fictícios plausíveis.

## Scripts de desenvolvimento

Na raiz do monorepo:

```bash
npm run build      # compila packages/cortex
npm run test       # testes unitários (vitest)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## Limitações desta sprint (S03)

- Sem discovery, fingerprint ou indexação real (S04+)
- Sem persistência SQLite funcional (dependência preparada)
- Tools MCP retornam payloads stub alinhados a `.atlas/contracts/ESTADOS_RESPOSTA.md`

## Contratos de referência

- `.atlas/contracts/SURFACE_MCP_CLI.md` — surface congelada
- `.atlas/contracts/ESTADOS_RESPOSTA.md` — estados operacionais
- `.atlas/contracts/CONTRATO_MVP.md` — contrato MVP
