# Prompt — Continuar implementação S11 (Absorção Athena → Argus)

Copie o bloco abaixo **inteiro** em um novo chat do Cursor (modo Agent) com o workspace em `/Volumes/Dados/projetos/argus`.

---

```
## Missão

Implementar a absorção do Athena no Argus seguindo o guia canônico. Não reinventar arquitetura — executar o guia task por task.

## Documentos obrigatórios (ler antes de codar)

1. `docs/adr/001-athena-absorption-and-mcp-surface.md` — decisões (12 tools MCP, layout `.argus/memory/`)
2. `docs/GUIA_IMPLEMENTACAO_S11_ABSORCAO.md` — execução (S11a→S11e, matrizes de port, gates, aceite)

## Repositórios

| Repo | Caminho | Uso |
|------|---------|-----|
| **Argus** (trabalhar aqui) | `/Volumes/Dados/projetos/argus` | Destino — branch `feat/s11-athena-absorption` |
| **Athena** (somente leitura) | `/Volumes/Dados/projetos/athena` | Origem do código a portar |

## Estado atual

- [x] ADR escrito
- [x] Guia de implementação escrito
- [ ] **Nenhum código S11 implementado ainda** — `packages/argus/src/memory/` não existe
- [ ] Fases S11a–S11e pendentes

## O que fazer agora

Começar pela **Fase S11a** do guia, na ordem:

1. **S11a-01** — Criar árvore `packages/argus/src/memory/` (stubs + index.ts)
2. **S11a-02** — `memory/paths.ts` (`.argus/memory/`, env `ARGUS_MEMORY_PATH`)
3. **S11a-03** — Constantes em `workspace/workspace.ts`
4. **S11a-04** — `memory/migrate-legacy-athena.ts` + testes
5. **S11a-05** — Hook em `commands/init.ts` e `commands/install.ts`

Parar e reportar ao concluir **S11a** (gate: `npm run validate` + testes de paths/migrate).

Depois seguir **S11b** (port vault, CLI `argus memory`, MCP `remember`/`recall`) sem pular fases.

## Regras de execução

1. **Seguir o guia** — cada tarefa tem arquivos, aceite e gate; marcar Definition of Done no guia quando concluir itens
2. **Port, não copy-paste cego** — renomear paths, remover `ArgusBridge`, usar `embeddings/embedder.ts` do Argus (não `@xenova`)
3. **Não portar** `argus-bridge.ts` nem `embedding-provider.ts` — substituir por `code-index-reader.ts` e embedder Argus
4. **Breaking changes OK** — sem usuários externos
5. **Commits** — só quando eu pedir; até lá trabalhar incrementalmente
6. **Gates por fase** — `npm run validate` mínimo; `homologate` a partir de S11b
7. **Escopo mínimo** — não adicionar features fora do guia/ADR
8. **Testes** — portar conforme matriz do guia; novo código com teste correspondente

## Decisões já fechadas (não reabrir sem me perguntar)

- 12 tools MCP: 10 existentes + `remember` + `recall`
- `athena_think` fica **interno** (flag `synthesize` em `pack_context`, fase S11d)
- Layout: `.argus/memory/vault/` + `memory.db` + `config.json`
- CLI: `argus memory *` (não binário `athena`)
- `argus install` inclui memory por default (`--no-memory` opt-out)
- Embeddings meta: `bge-small` + int8 (preferência ADR); sqlite-vec só se S11b atrasar (documentar dívida)

## Entregável por sessão

Ao terminar cada fase, responder com:

1. Tarefas concluídas (IDs: S11a-01, …)
2. Arquivos criados/alterados
3. Resultado dos gates (`validate`, testes específicos)
4. Próxima fase e bloqueios (se houver)

## Primeiro comando sugerido

```bash
cd /Volumes/Dados/projetos/argus
git checkout -b feat/s11-athena-absorption 2>/dev/null || git checkout feat/s11-athena-absorption
npm run validate  # baseline verde
```

Em seguida implementar S11a-01 conforme `docs/GUIA_IMPLEMENTACAO_S11_ABSORCAO.md`.
```

---

## Variante curta (se o chat tiver limite de contexto)

```
Implemente S11 absorção Athena→Argus em /Volumes/Dados/projetos/argus.
Leia docs/adr/001-athena-absorption-and-mcp-surface.md e docs/GUIA_IMPLEMENTACAO_S11_ABSORCAO.md.
Comece S11a (memory scaffold + paths + migrate .athena). Athena em /Volumes/Dados/projetos/athena só leitura.
Gate: npm run validate. Nada implementado ainda. Siga o guia task-a-task; reporte ao fim de cada fase.
```
