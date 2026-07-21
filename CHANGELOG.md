# Changelog

## Unreleased

## 2.2.0 - 2026-07-21

- surface MCP slim por default: ListTools anuncia cinco tools
  (`explore`, `pack_context`, `recall`, `remember`, `status`); as 12 registradas
  continuam invocáveis via CallTool/CLI. Override: `ARGUS_MCP_TOOLS=all` (ou CSV).
  **Compatibilidade:** hosts que cacheiam ListTools precisam **reiniciar** o
  processo MCP após o upgrade; unlisted não significa desabilitada
  (`retrieve` permanece unlisted — handle já vem do payload)
- `argus install --refresh` regenera o bloco de agent-rules versionado e
  reconverge entradas MCP; opt-out: `ARGUS_NO_INSTALL_REFRESH=1`
- explore/pack balanced entregam trechos verbatim acionáveis; `retrieve`
  publica `context_lines` no schema; explore truncado emite `retrieve_handle`
  reidratável
- memória: `remember` faz upsert quente (FTS) — `recall` same-session sem sync
  manual; ranking v2 com fatores de confidence/recência/sinais;
  `type=decision` grava `confidence=confirmed`
- hot embed unitário no `remember` (sem wipe/`memory sync` no happy path);
  `argus memory embed` incremental
- hot paths lazy (explore/pack/diff/retrieve/status) sem full-load estrutural
  default; sync delta sem materializar o índice anterior quando seguro
- concise preserva honesty acionável (`embedding_status`, `retrieve_handle`,
  códigos `E_*`/`W_*`)
- homologação S8v2 (jornada MCP, não churn LLM): corpora small/medium/stress +
  golden `homologate-agent-v2`; smoke do tarball valida ListTools slim +
  CallTool unlisted

## 2.1.2 - 2026-07-14

- correção: `argus status` (sem `--json`) agora exibe saída formatada legível (seções: repositório, índice estrutural, cobertura por linguagem, memória) em vez de JSON cru; o dist publicado 2.1.1 estava dessincronizado do fonte e não incluía o módulo `format-status`
- remoção de variável não utilizada em `formatCoverageLine` que bloqueava o build

## 2.1.1 - 2026-07-04

- pacote npm publicado como `@owerride/argus` (escopo do username npm `owerride`; nome `argus` sem escopo é de terceiro); binário CLI continua `argus`
- release CI republica no npmjs.org e no GitHub Release (`owerride-argus-*.tgz`)

## 2.1.0 - 2026-07-03

- novo host MCP: VS Code (`vscode`) com suporte a escopos local (`.vscode/mcp.json`) e global (`~/.vscode/mcp.json`), auto-detecção via binário `code` no PATH e integração completa com `argus install`/`argus uninstall`

## 2.0.1 - 2026-07-03

- correção: compatibilidade do plugin ZCode e registro MCP em hosts codex/opencode/pi/antigravity/zcode.
- correção: resolução de workspace no `argus serve --mcp` com fallback para múltiplos diretórios de configuração.

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
