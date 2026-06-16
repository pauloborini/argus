# Changelog

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
