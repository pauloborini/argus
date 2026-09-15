---
updated: 2026-09-14
scope: processo do Argus — roadmap, guides executados, dossies privados, issues e referencias de terceiros
---

# Argus — índice do processo (.app-work)

Mapa, não conteúdo. O processo **nunca** é insumo de regra: verdade vigente só em `_app-vault/docs/decisions/`.

## Pastas canônicas

| Pasta | Papel |
|---|---|
| `hephaestus-state.json` | estado versionado do kit (raiz) |
| `guides/` | packs de execução em andamento (`<NOME>_GUIDE/` com INTENT, GUIDE, LEDGER e `plans/`) |
| `guides/legados/` | monolíticos ainda citados sem pack próprio |
| `roadmap/` | fila viva versionada (`ROADMAP.md` + `slices/`) — nunca em `private/` |
| `brainstorming/` | caderno de processo — ao fechar, roteia e não permanece como referência viva |
| `prd/` | propostas datadas — não são contrato |
| `docs/` | docs de operação/produto vivos; omitir se vazio |
| `references/` | refs open source de terceiros — SEMPRE gitignored; único lugar de clones |
| `private/` | área privada (`auditorias/`, `ops/`, `research/`, `notes/`) — SEMPRE gitignored |
| `issues/` | registro único de defeitos (`ISSUE-NNN`, ciclo OPEN → FIXED → VERIFIED → CLOSED) |
| `archive/` | espelho datado (`guides/<YYYY-MM>/semana-<N>/`, `perguntas/`, `prds/`, `roadmap/<MARCO>_<YYYY-MM>/`) + depósito nominado — apagável |

## Estado atual (2026-09)

- `.app-work/archive/guides/2026-07/semana-27/` e `semana-30/` — quatro packs executados no espelho datado (S11, LLM_RETRIEVAL_MEMORY, HARDENING, WORKSPACE_STATE_UNIFICATION).
- `.app-work/private/notes/DOSSIE_LLM_RETRIEVAL_MEMORY/` — dossiê técnico privado do ciclo de memória.
- `.app-work/private/MANUAL_RELEASE.md` + `RELEASE_BUMP.md` + `PATCH_PROCEDURE.md` — ops de release local (sem CI).
- `.app-work/roadmap/ROADMAP.md` — marco V2 concluído (M1..M4).
- `issues/` é local-only: o repositório é público e o registro carrega contexto interno.

## Visibilidade (versionamento)

Versionados: `.app-work/.gitignore`, `INDEX.md`, `roadmap/` e `hephaestus-state.json`. O restante do processo é local (guias executados, dossiês, ops privadas, issues e clones de terceiros).

## Regras de ouro

- `.app-work/` é processo: **nunca** insumo de regra.
- Uma cópia canônica por arquivo: cópia idêntica em outro lugar é lixo; antes de remover, provar duplicata byte a byte (`cmp`).
- **Espelho do archive (concluído, mover não duplicar):** `guides/<PACK>/` → `archive/guides/<YYYY-MM>/semana-<N>/<PACK>/`; `brainstorming/<tema>/` fechado → `archive/perguntas/<tema>/`; PRD aposentado → `archive/prds/`; roadmap de marco → `archive/roadmap/<MARCO>_<YYYY-MM>/`. Issues não espelham (registro único).
- Guia convertido a pack descarta o monolítico — a cópia do monolítico em `done/` não sobrevive.
- Cada pasta com muito conteúdo tem seu próprio `README.md` — o índice não duplica conteúdo de pasta.
- `.app-work/` inteiro é oculto à busca (`rg --files` não o varre); o que não for promovido a decisão está efetivamente perdido — registrar `Candidatos a decisão` no `LEDGER.md` dos packs.
