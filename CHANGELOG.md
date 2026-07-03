# Changelog

## 2.0.0 - 2026-07-02

- BREAKING: Athena absorvido pelo Argus: um binário (`argus`), um MCP (`argus serve --mcp`) e um estado (`.argus/`).
- novo módulo `packages/argus/src/memory/` com vault local em `.argus/memory/`, CLI `argus memory *`, storage SQLite/FTS e embeddings int8.
- MCP passa de 10 para 12 tools: adiciona `remember` e `recall`; não expõe `think` nem alias público `capture`.
- `semantic_search` aceita `domain=code|memory|all`; `explore`, `status`, `pack_context` e `retrieve` entendem memória.
- migração fail-closed de `.athena/` para `.argus/memory/`; `athena-vault.db` vira backup `legacy-athena-vault.db`, nunca runtime.
- avaliação de release S08: testes agregados `release-evaluation` e `release-privacy`, script `npm run release:eval` com dream dry-run real e veredito bloqueante (evidência em `.argus/release-evaluation/latest.json`), gates `validate` / `smoke:package` / `homologate` / `release:check`.
- sintese LLM permanece opt-in via `pack_context.synthesize` com `llm_provider` explícito; sem provider configurado a resposta é `parcial` com gaps.
- embeddings e provider LLM são opcionais; ambientes sem modelo degradam para `parcial`/`fts-only`, nunca promessa de certeza plena.

## 1.2.0 - 2026-06-30

- BREAKING: rename do produto de Atlas Cortex para Argus (binário, nome de pacote, diretório de estado `.cortex/`→`.argus/`, chave de MCP server, todos os comandos de instalação).

## 1.1.0 - 2026-06-30

- novos adapters MCP: opencode, pi, antigravity, zcode (total de 7 hosts suportados)
- comando `cortex install` com deteccao automatica de hosts (`--hosts`, `--global`/`--local`)
- comando `cortex uninstall` com limpeza seletiva por host e escopo
- CLI com help expandido: tabela de hosts, escopos e paths de config
- testes completos para novos adapters (mcp-hosts, mcp-hosts-codex)

## 1.0.1 - 2026-06-15

- comando `cortex install` para fiação zero-toque do repo (workspace + índice + agent-rules + MCP + daemon)
- comando `cortex uninstall` para reversão completa (com `--purge` para `.cortex/`)
- comando `cortex daemon` (start, stop, restart, status, reload, install-service, uninstall-service)
- daemon de auto-sync com watcher de filesystem (`@parcel/watcher`) e serviço de usuário (launchd/systemd)
- sync por paths explícitos do watcher (`via watch`) com lock de workspace e fallback para dirty-flag
- README/COMMANDS simplificados: quickstart em um comando
- correção: removida auto-referência `atlas-cortex` em devDependencies (bloqueava publish)

## 1.0.0 - 2026-06-13

- superfície MCP/CLI local com nove tools
- retrieve público e reversível por handle
- resolução de chamadas orientada a imports
- ranking lexical composto e filtros de busca
- diff impact por hunk e símbolo
- pacote npm, plugin Codex e release GitHub verificável
