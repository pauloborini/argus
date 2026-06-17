<!-- Idioma: [English](README.md) · **Português** -->

# Atlas Cortex

**Code retrieval e context packing local para agentes de código.**

O Atlas Cortex indexa um repositório uma vez e responde às perguntas
estruturais de um agente — *onde está este símbolo, o que o chama, o que quebra
se eu mudar, me dê só o contexto relevante* — sem o agente ler e reler
arquivos. Roda inteiramente na sua máquina, não tem UI e fala duas interfaces:
um **CLI** e um **servidor MCP**.

> 📖 Quer a lista exaustiva de comandos? Veja **[COMMANDS.pt-BR.md](COMMANDS.pt-BR.md)**.
> Este README explica o *porquê* e o *como*; o COMMANDS é a referência pura.

---

## Por que existe

Agentes queimam tokens e tool calls redescobrindo o código: `grep`, abre
arquivo, `grep` de novo, abre mais três. O Atlas Cortex colapsa isso em
respostas únicas e estruturadas apoiadas num índice local.

No benchmark interno (6 tarefas reais de engenharia, **scriptado — sem agente
vivo**, tokens por heurística offline documentada):

| Métrica (baseline → Atlas) | Resultado |
|---|---|
| Tokens aprox. | **−92,7%** |
| Tool calls | **−11,8%** |
| Ground-truth respondido (arm Atlas) | **6/6** |

O ganho de tokens vem quase todo do **índice entregar menos conteúdo** (ranges +
handles em vez de arquivos inteiros), não de formato — isolado, o ganho só-de-formato
é **~0%**. Compensa mais em **lookup cirúrgico** (−97,8%) e menos em **varredura
ampla** (−55,7%), onde o agente leria muitos arquivos de qualquer jeito. É um
**limite superior interno scriptado** até rodar com agente vivo; metodologia e
números por task em [`.atlas/benchmark/latest/SUMMARY.md`](.atlas/benchmark/latest/SUMMARY.md).

É **local-first**: nada é indexado ou enviado para serviço remoto, e o contexto
recuperado nunca sai do workspace.

---

## Requisitos

- Node.js **>= 20**

---

## Instalação

```bash
# Instalação global — dá o binário `cortex`
npm install -g atlas-cortex
cortex --version

# Ou rode sem instalar
npx atlas-cortex init
```

---

## Início rápido

Um comando fia o repo de ponta a ponta — depois é só codar.

```bash
# Fia o repo: workspace + índice + MCP nos seus hosts + daemon de auto-sync
cortex install

# Fazer perguntas
cortex search "calculateTotal"            # achar um símbolo rápido
cortex explore src/billing.ts --mode file # contexto estruturado de um arquivo
```

Após o `install`, o daemon de auto-sync mantém o índice fresco a cada save — sem
`sync` manual. Veja `cortex daemon status` para o que está sendo observado e
`cortex status` para staleness. **Todo o resto — `trace`, `impact`,
`diff-impact`, `pack-context`, `retrieve`, mais os controles de `daemon` — está
no [COMMANDS.pt-BR.md](COMMANDS.pt-BR.md) com flags e exemplos completos.**

---

## Usar como servidor MCP

Aponte seu agente ou IDE para o servidor MCP stdio:

```json
{
  "mcpServers": {
    "atlas-cortex": {
      "command": "npx",
      "args": ["-y", "atlas-cortex@latest", "serve", "--mcp"]
    }
  }
}
```

O servidor expõe dez tools: `search`, `explore`, `trace`, `impact`,
`diff_impact`, `files`, `pack_context`, `retrieve`, `status` e
`semantic_search`. Todas leem apenas estado local.

---

## Manter o índice fresco (opcional)

Você pode deixar o índice se manter fresco sozinho, para o agente nunca
consultar estado velho e você nunca rodar `cortex sync` na mão:

```bash
cortex hook install         # hooks git marcam o que mudou (sem travar commit)
cortex agent-rules install  # instrui agentes a usar o cortex (CLAUDE.md + AGENTS.md)
```

Os hooks git só *marcam* o índice como sujo; o servidor MCP roda um sync
incremental e git-aware de forma preguiçosa antes de responder. O commit nunca
trava, e erro de sync degrada honestamente para `parcial` + `staleness_hint`.
Veja [COMMANDS → Sync de baixo atrito](COMMANDS.pt-BR.md#sync-de-baixo-atrito).

---

## Lendo as respostas

Toda tool retorna JSON com o mesmo envelope de honestidade, então o agente
sempre sabe o quanto confiar num resultado:

- **`state`** — `sucesso` (limpo), `ambigua` (vários matches equivalentes),
  `parcial` (cobertura parcial / staleness incerta), `stale` (índice atrás do
  código), `falha` (não dá para responder).
- **`confidence`** — `high` / `medium` / `low`.
- **`limitations`** e **`staleness_hint`** — presentes quando algo pode estar
  fora, dizendo o que fazer (ex.: rodar `cortex sync`).

Duas ideias que valem conhecer:

- **Staleness.** O índice pode divergir do código. `status` e toda query
  expõem `fresh` / `stale` / `unknown` — resultado nunca é silenciosamente
  errado.
- **Retrieve handles.** `pack_context` pode retornar um contexto compacto mais
  um handle opaco (`rh_…`). `retrieve <handle>` reidrata o original, sob
  demanda, confinado ao mesmo workspace.

---

## Linguagens suportadas

| Camada | Linguagens | Cobertura |
|---|---|---|
| Core | TypeScript/JavaScript, Python, Go, Java, Rust | completa |
| Extensão | Dart, Kotlin | parcial (degradação honesta) |

Dart tem extração estrutural de primeira classe (classes, mixins, typedefs,
constantes top-level, relações `with`/`on`) por causa do Flutter.

---

## Limitações conhecidas

- Chamadas sem import resolvido degradam para correspondência global por nome (mitigável via importação SCIP opcional — `cortex scip import`).
- Dart/Kotlin mantêm cobertura parcial explícita.
- Resolução dinâmica/reflexiva não é tratada como causalidade comprovada.
- `search` rankeia lexical e estruturalmente (sempre fresco). Busca semântica
  por **embeddings é opcional e off-by-default**: rode `cortex embed` e use a tool
  `semantic_search` (denso bge-small + fusão híbrida RRF). Os vetores não são
  auto-sincronizados — podem ficar stale e a tool sinaliza honestamente.

---

## Desenvolvimento

```bash
npm ci
npm run validate        # typecheck + testes + lint + build
```

Scripts de build, benchmark, smoke, homologação e release estão documentados em
[COMMANDS.pt-BR.md → Desenvolvimento & release](COMMANDS.pt-BR.md#desenvolvimento--release).

---

## Mapa da documentação

- **[COMMANDS.pt-BR.md](COMMANDS.pt-BR.md)** — todos os comandos, flags e campos de saída.
- [CONTRIBUTING.md](CONTRIBUTING.md) — como contribuir.
- [SECURITY.md](SECURITY.md) — reporte de vulnerabilidades.
- [CHANGELOG.md](CHANGELOG.md) — histórico de releases.
- `.atlas/contracts/` — surface MCP/CLI congelada e contratos de estado.

---

## Licença

Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
