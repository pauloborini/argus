# RULES: ARCHITECTURE

## Papel

Definir camadas, boundaries e dependências do monorepo.

## Camadas e papéis

- `packages/argus/src/discovery` — descoberta de arquivos (respeita `.gitignore`, ignora `node_modules`/`dist`, limite de tamanho).
- `packages/argus/src/extraction` — parsing estrutural (tree-sitter; linguagens core TS/JS, Python, Go, Java, Rust + extensão Dart, Kotlin, C#).
- `packages/argus/src/storage` — SQLite/FTS, schema e migrações; `packages/argus/src/embeddings` — vetores opcionais (off por default).
- `packages/argus/src/packing` — compressão, ranking e handles reversíveis; `packages/argus/src/memory` — cofre local v2 (módulo absorvido do Athena, DEC-013).
- `packages/argus/src/mcp` — servidor stdio e registry de tools; `packages/argus/src/daemon` — watch/sync e serviço de auto-start.
- `packages/argus/src/workspace` — resolução do root canônico e paths de estado; `packages/argus/src/install` — wiring de hosts e agent-rules; `packages/argus/src/scip` — import opcional de SCIP.

## Regras de dependência

- Camadas de leitura (`discovery`, `extraction`, `storage`) não dependem de `mcp`/`daemon`/`install`.
- `mcp` e `daemon` são adaptadores: não contêm regra de negócio, só tradução de entrada/saída.
- Nenhum módulo executa código do workspace indexado.
- Todo caminho lido ou devolvido é resolvido a partir do root canônico e confinado a ele.

## Estado e workspace

- Um único `<rootPath>/.argus/` por workspace guarda índice, dirty, lock, memória e handles (DEC-015).
- O root canônico é o `realpath` do diretório que contém `workspace.json`. Divergiu, o produto **cura** com o warning estável `W_WORKSPACE_ROOT_HEALED`; metadata ilegível falha alto com `E_WORKSPACE_INVALID`, sem fallback silencioso, symlink ou merge de dois `.argus`.
- Um `.argus` sombra em path antigo é **diagnosticado, nunca auto-deletado** — a migração é manual.

## TypeScript

- Base estrita (`tsconfig.base.json`): ES2022 + NodeNext, `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, declarations e sourcemaps.
- O pacote compila `src/` para `dist/`; `tests/` fica fora do build e roda em vitest.
- ESLint flat config com typescript-eslint recommended; prefixo `_` marca parâmetro/variável intencionalmente não usado.

## Daemon

- Serviço de auto-start recebe `PATH` e `HOME` explícitos (launchd `EnvironmentVariables`, systemd `Environment`).
- Exaustão de watcher (`ENOSPC`/`EMFILE`) produz hint acionável (`max_user_watches`/`polling`); erro comum de backend cai em resubscribe silencioso.

## Invariantes verificáveis

- `npm run typecheck`, `npm run lint` e `npm test` verdes em qualquer diff.
- Nenhum `console.log` no caminho stdio do MCP (a regra de stdout limpo está em `security_rules.md`).
