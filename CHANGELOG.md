# Changelog

## 1.0.5 - 2026-06-16

- adiciona binario npm homonimo `atlas-cortex`, mantendo alias `cortex`
- corrige uso via `npx atlas-cortex`
- reforca smoke do pacote para validar os dois bins

## 1.0.4 - 2026-06-16

- corrige release npm para repositório privado, publicando com `NPM_TOKEN` sem provenance
- documenta que provenance npm exige repositório público

## 1.0.3 - 2026-06-16

- corrige pipeline de release npm com `NPM_TOKEN` e provenance explicito
- alinha `package-lock.json` ao bump e faz `release:check` bloquear drift futuro
- atualiza exemplos MCP para `atlas-cortex@latest`
- adiciona runbook de bump/release para IA em `docs/RELEASE_BUMP.md`
- tag criada, mas versao nao publicada no npm porque provenance nao suporta repositorio privado

## 1.0.2 - 2026-06-16

- teste do CI de release com Automation token do npm (NPM_TOKEN via secret)
- nenhuma mudança de código; bump de versão para validar o pipeline automatizado
- tag criada, mas versao nao publicada no npm; usar `1.0.4` como release corrigido

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
