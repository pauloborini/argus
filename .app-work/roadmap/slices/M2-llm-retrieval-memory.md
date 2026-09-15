# M2 — Retrieval e Memória Acionáveis

> Um arquivo por fatia, em `.app-work/roadmap/slices/M2-llm-retrieval-memory.md`.
>
> Este arquivo é a **autoridade** do estado da fatia. A coluna `Estado` da matriz em
> `ROADMAP.md` é espelho, sincronizado só quando `$pack-roadmap` roda.

**Estado:** Concluída
**Pack:** .app-work/archive/guides/LLM_RETRIEVAL_MEMORY_GUIDE/
**Prioridade:** P0
**Objetivo:** Surface MCP slim com 4 tools padrão, explore em chamada única e memória SQLite v2.
**Depende de:** M1
**Decisões que restringem:** D2, D3, D5

## Superfícies afetadas

| Superfície | App / tela | Efeito observável |
|---|---|---|
| MCP Server | mcp/tools | ListTools slim com 4 ferramentas e comandos explore/remember funcionais |
| Memória | src/memory | Cofre SQLite local v2 com FTS5 e busca híbrida |
