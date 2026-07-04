<!-- Idioma: [English](README.md) · **Português** -->
<p align="center">
  <img src="docs/assets/atlas-logo.png" alt="Atlas" width="96" height="96">
</p>

# Argus

**Code retrieval, memória local e context packing para agentes de código.**

O Argus indexa um repositório uma vez e responde às perguntas
estruturais de um agente — *onde está este símbolo, o que o chama, o que quebra
se eu mudar, me dê só o contexto relevante* — sem o agente ler e reler
arquivos. Também mantém um cofre local em `.argus/memory/` para decisões,
notas e contexto de projeto. Roda inteiramente na sua máquina, não tem UI e fala duas interfaces:
um **CLI** e um **servidor MCP**.

> 📖 Quer a lista exaustiva de comandos? Veja **[COMMANDS.pt-BR.md](COMMANDS.pt-BR.md)**.
> Este README explica o *porquê* e o *como*; o COMMANDS é a referência pura.

---

## Por que existe

Agentes queimam tokens e tool calls redescobrindo o código: `grep`, abre
arquivo, `grep` de novo, abre mais três. O Argus colapsa isso em
respostas únicas e estruturadas apoiadas num índice local.

No benchmark interno (6 tarefas reais de engenharia, **scriptado — sem agente
vivo**, tokens por heurística offline documentada):

| Métrica (baseline → Argus) | Resultado |
|---|---|
| Tokens aprox. | **−92,7%** |
| Tool calls | **−11,8%** |
| Ground-truth respondido (arm Argus) | **6/6** |

O ganho de tokens vem quase todo do **índice entregar menos conteúdo** (ranges +
handles em vez de arquivos inteiros), não de formato — isolado, o ganho só-de-formato
é **~0%**. Compensa mais em **lookup cirúrgico** (−97,8%) e menos em **varredura
ampla** (−55,7%), onde o agente leria muitos arquivos de qualquer jeito. É um
**limite superior interno scriptado** até rodar com agente vivo; metodologia e
números por task em [`.argus/benchmark/latest/SUMMARY.md`](.argus/benchmark/latest/SUMMARY.md).

É **local-first**: nada é indexado ou enviado para serviço remoto, e o contexto
recuperado nunca sai do workspace.

---

## Requisitos

- Node.js **>= 20**

---

## Instalação

O Argus **não** está no registry npm público como `argus` (esse nome é de outro pacote). Instale pelo tarball do **GitHub Release**:

```bash
# Troque X.Y.Z pela tag mais recente em https://github.com/pauloborini/argus/releases
npm install -g https://github.com/pauloborini/argus/releases/download/v2.1.0/argus-2.1.0.tgz
argus --version
```

Com a [GitHub CLI](https://cli.github.com/):

```bash
VERSION=$(gh release view --repo pauloborini/argus --json tagName -q .tagName | sed 's/^v//')
gh release download "v${VERSION}" --repo pauloborini/argus --pattern 'argus-*.tgz' -D /tmp
npm install -g "/tmp/argus-${VERSION}.tgz"
```

Build a partir do fonte (contribuidores):

```bash
git clone https://github.com/pauloborini/argus.git && cd argus
npm ci && npm run build && npm link --workspace=argus
```

Fiar um projeto:

```bash
cd seu-repo
argus install
```

**Atualizar:** `npm install -g` com a URL da release nova.

**Desinstalar:** `npm uninstall -g argus`

| **Não** use | Por quê |
|---|---|
| `npm install -g argus` | Pacote errado no npmjs.org |
| `npx argus …` | Idem |

---

## Início rápido

Um comando fia o repo de ponta a ponta — depois é só codar.

```bash
# Fia o repo: workspace + índice + MCP nos seus hosts + daemon de auto-sync
argus install

# Fazer perguntas
argus search "calculateTotal"            # achar um símbolo rápido
argus explore src/billing.ts --mode file # contexto estruturado de um arquivo
```

Após o `install`, o daemon de auto-sync mantém o índice fresco a cada save — sem
`sync` manual. Veja `argus daemon status` para o que está sendo observado e
`argus status` para staleness. **Todo o resto — `trace`, `impact`,
`diff-impact`, `pack-context`, `retrieve`, mais os controles de `daemon` — está
no [COMMANDS.pt-BR.md](COMMANDS.pt-BR.md) com flags e exemplos completos.**

---

## Usar como servidor MCP

O jeito mais simples é deixar o `argus install` fiar os hosts por você — sem
`--hosts`, ele registra **Claude Code** e **Cursor** e auto-detecta **Codex**,
**OpenCode**, **Pi**, **Antigravity** e **ZCode** quando instalados
(`--global`/`--local`/`--scope` controlam o escopo; `argus uninstall` reverte
tudo inclusive registro no daemon e servico auto-start — veja
[COMMANDS](COMMANDS.pt-BR.md#argus-install--comando-de-entrada)).

Para fiar à mão, aponte seu agente ou IDE para o servidor MCP stdio:

```json
{
  "mcpServers": {
    "argus": {
      "command": "argus",
      "args": ["serve", "--mcp"]
    }
  }
}
```

O servidor expõe doze tools: `search`, `explore`, `trace`, `impact`,
`diff_impact`, `files`, `pack_context`, `retrieve`, `status` e
`semantic_search`, além de `remember` e `recall` para memória. Todas leem/escrevem apenas estado local.

---

## Manter o índice fresco (opcional)

Você pode deixar o índice se manter fresco sozinho, para o agente nunca
consultar estado velho e você nunca rodar `argus sync` na mão:

```bash
argus hook install         # hooks git marcam o que mudou (sem travar commit)
argus agent-rules install  # instrui agentes a usar o argus (CLAUDE.md + AGENTS.md)
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
  fora, dizendo o que fazer (ex.: rodar `argus sync`).

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
| Extensão | Dart, Kotlin, C# | completa |

Dart tem extração estrutural de primeira classe (classes, mixins, typedefs,
constantes top-level, relações `with`/`on`) por causa do Flutter. C# cobre
namespaces, classes, structs, records, interfaces, enums e membros top-level
(`.cs`/`.csx`).

---

## Limitações conhecidas

- Chamadas sem import resolvido degradam para correspondência global por nome (mitigável via importação SCIP opcional — `argus scip import`).
- Resolução dinâmica/reflexiva não é tratada como causalidade comprovada.
- `search` rankeia lexical e estruturalmente (sempre fresco). Busca semântica
  por **embeddings é opcional e off-by-default**: rode `argus embed` e use a tool
  `semantic_search` (denso bge-small + fusão híbrida RRF). Os vetores não são
  auto-sincronizados — podem ficar stale e a tool sinaliza honestamente.
- Memória inteligente (`remember`/`recall`, `pack_context` com `synthesize`,
  `memory dream`) é **local-first**: nada sai do workspace sem configuração explícita
  de provider LLM; sem embeddings ou LLM o runtime retorna `parcial` com limitações
  documentadas, não certeza plena.

---

## Release e validação

Gates de release no monorepo (sem SLA de performance — valores orientativos):

| Comando | Função |
|---|---|
| `npm run validate` | typecheck + testes + lint + build |
| `npm run smoke:package` | tarball instalável + MCP 12 tools |
| `npm run homologate` | sondas em ≥2 repos locais (`ARGUS_HOMOLOGATION_REPOS`) |
| `npm run release:check` | consistência de versão |
| `npm run release:eval` | evidência agregada memória/privacidade/performance com veredito bloqueante → `.argus/release-evaluation/latest.json` |

Checklist de privacidade e avaliação agregada S05–S07: `packages/argus/tests/memory/release-evaluation.test.ts` e `packages/argus/tests/release-privacy.test.ts`. A avaliação de release usa dream dry-run real e sai com código não-zero quando o veredito não é `passed`.

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
- `.argus/contracts/` — surface MCP/CLI congelada e contratos de estado.

---

## Licença

Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
