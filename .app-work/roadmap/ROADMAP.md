# Argus — Roadmap

> **Núcleo do Roadmap Pack.** Duas seções, e nada mais: decisões de produto e matriz de fatias.
> Gerado/atualizado pela skill `pack-roadmap`. Vive em `.app-work/roadmap/ROADMAP.md`.
>
> O detalhe de cada fatia mora em `slices/M<n>-<slug>.md`, um arquivo por fatia.
> Este núcleo **não cresce** com o número de fatias, exceto por uma linha de índice cada.
>
> **Estado é autoridade do slice.** A coluna `Estado` da matriz é espelho, sincronizado só
> quando `$pack-roadmap` roda. Espelho defasado entre execuções é esperado, não defeito.

**Marco / objetivo deste roadmap:** Marco V2 — Indexação Estrutural Local, Memória Persistente SQLite e Unificação de Estado de Workspace.
**Entrevista de decisões:** `.app-work/archive/001-athena-absorption-and-mcp-surface.md` · `_app-vault/specs/MEMORY_V2_CONTRACT.md` · dossiê `.app-work/private/notes/DOSSIE_LLM_RETRIEVAL_MEMORY/`
**Criado em:** 2026-07-21 · **Última atualização:** 2026-09-08

---

## 1. Decisões de produto

Decisão **transversal**: restringe várias fatias e não pertence a nenhuma. Fechada aqui **uma vez**
e herdada pelos `INTENT.md` dos packs. Decidir isto no pack-intent da fatia 7 chega tarde, porque as
fatias 1–6 já viraram código sob outra suposição.

**Teste de transversalidade:** enunciar a decisão sem nomear nenhuma fatia ou superfície. Se não
der, ela é de fatia e pertence ao `INTENT.md` §1 do pack, não a esta tabela.

| ID | Rev | Decisão (enunciado) | Consequência observável | Fonte | Restringe fatias |
|---|---|---|---|---|---|
| D1 | r1 | Interface dual CLI e servidor MCP via stdio em binário único com diretório canônico .argus/ | Agentes e usuários operam a mesma ferramenta e o mesmo índice via terminal ou MCP | `usuário:` ADR 001 (001-athena-absorption-and-mcp-surface.md) | M1, M4 |
| D2 | r1 | Memória local SQLite v2 (FTS5 + busca vetorial híbrida) no diretório canônico do workspace | Notas, decisões e fatos persistem localmente sob .argus/memory/ com recall rápido | `usuário:` docs/MEMORY_V2_CONTRACT.md | M2, M4 |
| D3 | r1 | Surface MCP slim por padrão: no máximo 4 tools default expostas para evitar context churn | Host MCP consome explore, status, remember e recall com tools avançadas sob demanda | `usuário:` DOSSIE D1..D3 + LLM_RETRIEVAL_MEMORY_GUIDE | M2, M3 |
| D4 | r1 | Resolução estrita de workspace raiz: eliminada dualidade cwd vs rootPath em todo o lifecycle | Toda escrita e leitura de índice, lock e memória ocorre estritamente em <rootPath>/.argus/ | `usuário:` conversa 2026-07-21 + WORKSPACE_STATE_UNIFICATION_GUIDE | M4 |
| D5 | r1 | Respostas compactas e reversíveis com handles de contexto sem carga estrutural pesada | Explore truncado emite handle semântico que reidrata trechos sem releitura completa | `usuário:` DOSSIE P1..P6 + HARDENING_GUIDE | M2, M3 |

---

## 2. Matriz de fatias

| ID | Fatia | Prioridade | Depende de | Decisões | Estado (espelho) | Slice |
|---|---|:---:|---|---|---|---|
| M1 | Absorção Athena e Unificação MCP | P0 | — | D1 | Concluída | `slices/M1-absorcao-athena.md` |
| M2 | Retrieval e Memória Acionáveis | P0 | M1 | D2, D3, D5 | Concluída | `slices/M2-llm-retrieval-memory.md` |
| M3 | Hardening de Retrieval e Truncamento | P0 | M2 | D3, D5 | Concluída | `slices/M3-retrieval-hardening.md` |
| M4 | Unificação de Estado de Workspace | P0 | M2, M3 | D1, D2, D4 | Concluída | `slices/M4-workspace-state-unification.md` |

**Exclusão justificada do marco:** Interface gráfica descartada (Argus é estritamente headless CLI/MCP). Telemetria remota rejeitada (local-first absoluto).
