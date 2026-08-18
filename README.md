<!-- Language: **English** · [Português](README.pt-BR.md) -->
<p align="center">
  <img src="assets/atlas-logo.png" alt="Atlas" width="200" height="200">
</p>

# Argus

**Local code + memory retrieval and context packing for coding agents.**

Argus indexes a repository once and answers an agent's structural
questions — *where is this symbol, what calls it, what breaks if I change it,
give me just the relevant context* — without the agent reading and re-reading
files. It also keeps a local knowledge vault under `.argus/memory/` for
decisions, notes and project context. It runs entirely on your machine, has no UI, and speaks two interfaces:
a **CLI** and an **MCP server**.

> 📖 Looking for the exhaustive command list? See **[COMMANDS.md](COMMANDS.md)**.
> This README explains the *why* and *how*; COMMANDS is the pure reference.

---

## Why it exists

Agents burn tokens and tool calls re-discovering a codebase: `grep`, open file,
`grep` again, open three more. Argus collapses that into single,
structured answers backed by a local index.

On the internal benchmark (6 real-repo engineering tasks, **scripted — not a live
agent**, tokens via a documented offline heuristic):

| Metric (baseline → Argus) | Result |
|---|---|
| Approx. tokens | **−94.9%** |
| Tool calls | **−11.8%** |
| Ground-truth answered (Argus arm) | **6/6** |

The token win is almost entirely the **index returning less content** (ranges +
handles instead of whole files), not formatting — isolated, the format-only gain is
**~0%**. It pays off most on **surgical lookups** (−98.8%) and less on **broad
sweeps** (−53.0%), where an agent reads many files regardless. This is an **internal
scripted upper bound** until a live-agent run lands; full method and per-task numbers
in [`docs/benchmark/SUMMARY.md`](docs/benchmark/SUMMARY.md).

It is **local-first**: nothing is indexed or sent to a remote service, and
recovered context never leaves the workspace.

---

## Requirements

- Node.js **>= 20**

---

## Install

```bash
npm install -g @owerride/argus
argus --version
```

The unscoped name `argus` on npmjs.org is a **different package** — always use `@owerride/argus` (npm scope matches the publisher account `owerride`).

Without a global install:

```bash
npx @owerride/argus init
```

Build from source (contributors):

```bash
git clone https://github.com/pauloborini/argus.git && cd argus
npm ci && npm run build && npm link --workspace=@owerride/argus
```

Wire any project:

```bash
cd your-repo
argus install
```

**Update:** `npm install -g @owerride/argus@latest`

**Uninstall:** `npm uninstall -g @owerride/argus`

| Do **not** use | Why |
|---|---|
| `npm install -g argus` | Wrong package on npmjs.org |
| `npx argus …` | Same |

---

## Quickstart

One command wires the repo end to end, then you just code.

```bash
# Wire the repo: workspace + index + MCP in your hosts + auto-sync daemon
argus install

# Ask questions
argus search "calculateTotal"            # find a symbol fast
argus explore src/billing.ts --mode file # structured context for a file
printf "# decision\n" | argus memory remember --stdin
argus memory search decision
```

After `install`, the auto-sync daemon keeps the index fresh on every save — no
manual `sync`. Check `argus daemon status` to see what's being watched, and
`argus status` for staleness. **Every other command — `trace`, `impact`,
`diff-impact`, `pack-context`, `retrieve`, plus the `daemon` controls — lives in
[COMMANDS.md](COMMANDS.md) with full flags and examples.**

---

## Use it as an MCP server

The simplest path is to let `argus install` wire your hosts — without `--hosts`
it registers **Claude Code** and **Cursor** and auto-detects **Codex**,
**OpenCode**, **Pi**, **Antigravity**, **ZCode** and **VS Code** when installed
(`--global`/`--local`/`--scope` control the scope; `argus uninstall` reverts
everything including daemon registration and auto-start service — see
[COMMANDS](COMMANDS.md#argus-install--entry-point-command)).

To wire it by hand, point your agent or IDE at the stdio MCP server:

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

**ListTools (default slim):** only five tools are advertised —
`explore`, `pack_context`, `recall`, `remember`, `status` — the happy path for agents.
All **twelve** registered tools remain callable via CallTool / CLI
(`search`, `trace`, `impact`, `diff_impact`, `files`, `retrieve`,
`semantic_search`, plus the five listed). Override discovery with
`ARGUS_MCP_TOOLS=all` (or a CSV allowlist); changing the env requires an MCP
**restart** (hosts often cache ListTools). Soft break: hosts that assumed
twelve listed tools must restart after upgrade.

`explore` / `pack_context` in **balanced** style return actionable verbatim
snippets (not signature-only). When a snippet is truncated by the balanced caps,
`explore` emits a `retrieve_handle` so CallTool `retrieve` rehydrates the full
body without reading the file via the host. `remember` hot-indexes (FTS; embed
when available) into the local vault so `recall` finds the fact in the same
session — do **not** run `memory sync` after remember (sync is a destructive
full rebuild, not a hot-path retry). After changing listed tools or agent-rules,
run `argus install --refresh` and restart the MCP host.

---

## Keep the index fresh (optional)

You can let the index stay fresh on its own, so the agent never queries stale
state and you never run `argus sync` by hand:

```bash
argus hook install         # git hooks mark what changed (never block a commit)
argus agent-rules install  # tell agents to use argus (CLAUDE.md + AGENTS.md)
```

Git hooks only *mark* the index dirty; the MCP server runs an incremental,
git-aware sync lazily before answering. Commits never stall, and sync errors
degrade honestly to `parcial` + `staleness_hint`. See
[COMMANDS → Low-friction sync](COMMANDS.md#low-friction-sync).

---

## Reading the answers

Every tool returns JSON with the same honesty envelope, so an agent always
knows how much to trust a result:

- **`state`** — `sucesso` (clean), `ambigua` (several equivalent matches),
  `parcial` (partial coverage / uncertain staleness), `stale` (index behind the
  code), `falha` (cannot answer).
- **`confidence`** — `high` / `medium` / `low`.
- **`limitations`** and **`staleness_hint`** — present when something might be
  off, telling you what to do (e.g. run `argus sync`).

Two ideas worth knowing:

- **Staleness.** The index can drift from the code. `status` and every query
  surface `fresh` / `stale` / `unknown` so results are never silently wrong.
- **Retrieve handles.** `pack_context` may return a compact context plus an
  opaque handle (`rh_…` for code, `mh_…` for memory). `retrieve <handle>` rehydrates the original, on
  demand, confined to the same workspace.

---

## Supported languages

| Tier | Languages | Coverage |
|---|---|---|
| Core | TypeScript/JavaScript, Python, Go, Java, Rust | full |
| Extension | Dart, Kotlin, C# | full |

Dart gets first-class structural extraction (classes, mixins, typedefs,
top-level constants, `with`/`on` relations) because of Flutter. C# covers
namespaces, classes, structs, records, interfaces, enums, and top-level
members (`.cs`/`.csx`).

---

## Known limitations

- Calls without a resolved import degrade to global name matching (mitigable via optional SCIP import — `argus scip import`).
- Dynamic/reflective resolution is not treated as proven causality.
- `search` ranks lexically and structurally (always fresh). Semantic
  **embeddings are optional and off-by-default**: run `argus embed` and use the
  `semantic_search` tool (dense bge-small + hybrid RRF fusion). Vectors are not
  auto-synced — they can go stale, and the tool signals it honestly.
- Intelligent memory (`remember`/`recall`, `pack_context` with `synthesize`,
  `memory dream`) is **local-first**: nothing leaves the workspace without an
  explicit LLM provider config; without embeddings or LLM the runtime returns
  `parcial` with documented limitations, not full certainty. The daemon also
  schedules a periodic consolidation cycle (`dream`, dry-run by default) per
  workspace — see [COMMANDS → daemon](COMMANDS.md).
- Workspace state lives in a **single** `.argus/` at the canonical root
  (realpath of the directory holding `workspace.json`). If `root_path` diverges,
  Argus heals it automatically (warning `W_WORKSPACE_ROOT_HEALED`) rather than
  splitting state across two paths. A shadow `.argus` at an old path is
  **diagnosed, never auto-deleted** — migrate it manually.

---

## Release validation

Monorepo release gates (no performance SLA — indicative timings only):

| Command | Role |
|---|---|
| `npm run validate` | typecheck + tests + lint + build |
| `npm run smoke:package` | installable tarball + MCP ListTools slim (5) + CallTool unlisted |
| `npm run homologate` | ≥2 corpora (fixtures by default) + S8v2 MCP journey golden (`homologate-agent-v2`) |
| `npm run release:check` | version consistency |
| `npm run release:eval` | aggregated memory/privacy/performance evidence with blocking verdict → `.argus/release-evaluation/latest.json` |

Privacy checklist and S05–S07 aggregate evaluation: `packages/argus/tests/memory/release-evaluation.test.ts` and `packages/argus/tests/release-privacy.test.ts`. The release evaluation uses a real dream dry-run and exits non-zero when the verdict is not `passed`.

---

## Development

```bash
npm ci
npm run validate        # typecheck + tests + lint + build
```

Build, benchmark, smoke, homologation and release scripts are documented in
[COMMANDS.md → Development & release](COMMANDS.md#development--release).

---

## Documentation map

- **[COMMANDS.md](COMMANDS.md)** — every command, flag and output field.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute ([Português](CONTRIBUTING.pt-BR.md)).
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities.
- [CHANGELOG.md](CHANGELOG.md) — release history.
- `.argus/contracts/` — frozen MCP/CLI surface and response-state contracts.

---

## License

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
