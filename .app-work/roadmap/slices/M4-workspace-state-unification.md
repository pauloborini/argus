# M4 — Unificação de Estado de Workspace

> Um arquivo por fatia, em `.app-work/roadmap/slices/M4-workspace-state-unification.md`.
>
> Este arquivo é a **autoridade** do estado da fatia. A coluna `Estado` da matriz em
> `ROADMAP.md` é espelho, sincronizado só quando `$pack-roadmap` roda.

**Estado:** Concluída
**Pack:** .app-work/archive/guides/WORKSPACE_STATE_UNIFICATION_GUIDE/
**Prioridade:** P0
**Objetivo:** Eliminação de dual-write cwd vs rootPath garantindo persistência única em <rootPath>/.argus/.
**Depende de:** M2, M3
**Decisões que restringem:** D1, D2, D4

## Superfícies afetadas

| Superfície | App / tela | Efeito observável |
|---|---|---|
| Workspace | packages/argus/src/workspace | Resolução de root canônico e alinhamento de locks e manifestos |
