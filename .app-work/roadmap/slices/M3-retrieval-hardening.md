# M3 — Hardening de Retrieval e Truncamento

> Um arquivo por fatia, em `.app-work/roadmap/slices/M3-retrieval-hardening.md`.
>
> Este arquivo é a **autoridade** do estado da fatia. A coluna `Estado` da matriz em
> `ROADMAP.md` é espelho, sincronizado só quando `$pack-roadmap` roda.

**Estado:** Concluída
**Pack:** .app-work/archive/guides/LLM_RETRIEVAL_MEMORY_HARDENING_GUIDE/
**Prioridade:** P0
**Objetivo:** Truncamento reversível via handles semânticos e remember discoverável no ListTools default.
**Depende de:** M2
**Decisões que restringem:** D3, D5

## Superfícies afetadas

| Superfície | App / tela | Efeito observável |
|---|---|---|
| MCP Server | explore / retrieve | Agente reidrata contexto truncado sem releitura completa do filesystem |
