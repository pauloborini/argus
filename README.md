<!-- Language: **English** · [Português](README.pt-BR.md) -->

# Atlas Cortex

**Local code retrieval and context packing for coding agents.**

Atlas Cortex indexes a repository once and answers an agent's structural
questions — *where is this symbol, what calls it, what breaks if I change it,
give me just the relevant context* — without the agent reading and re-reading
files. It runs entirely on your machine, has no UI, and speaks two interfaces:
a **CLI** and an **MCP server**.

> 📖 Looking for the exhaustive command list? See **[COMMANDS.md](COMMANDS.md)**.
> This README explains the *why* and *how*; COMMANDS is the pure reference.

---

## Why it exists

Agents burn tokens and tool calls re-discovering a codebase: `grep`, open file,
`grep` again, open three more. Atlas Cortex collapses that into single,
structured answers backed by a local index.

On the internal benchmark (6 real-repo engineering tasks, **scripted — not a live
agent**, tokens via a documented offline heuristic):

| Metric (baseline → Atlas) | Result |
|---|---|
| Approx. tokens | **−92.7%** |
| Tool calls | **−11.8%** |
| Ground-truth answered (Atlas arm) | **6/6** |

The token win is almost entirely the **index returning less content** (ranges +
handles instead of whole files), not formatting — isolated, the format-only gain is
**~0%**. It pays off most on **surgical lookups** (−97.8%) and less on **broad
sweeps** (−55.7%), where an agent reads many files regardless. This is an **internal
scripted upper bound** until a live-agent run lands; full method and per-task numbers
in [`.atlas/benchmark/latest/SUMMARY.md`](.atlas/benchmark/latest/SUMMARY.md).

It is **local-first**: nothing is indexed or sent to a remote service, and
recovered context never leaves the workspace.

---

## Requirements

- Node.js **>= 20**

---

## Install

```bash
# Global install — gives you the `cortex` binary
npm install -g atlas-cortex
cortex --version

# Or run without installing
npx atlas-cortex init
```

---

## Quickstart

One command wires the repo end to end, then you just code.

```bash
# Wire the repo: workspace + index + MCP in your hosts + auto-sync daemon
cortex install

# Ask questions
cortex search "calculateTotal"            # find a symbol fast
cortex explore src/billing.ts --mode file # structured context for a file
```

After `install`, the auto-sync daemon keeps the index fresh on every save — no
manual `sync`. Check `cortex daemon status` to see what's being watched, and
`cortex status` for staleness. **Every other command — `trace`, `impact`,
`diff-impact`, `pack-context`, `retrieve`, plus the `daemon` controls — lives in
[COMMANDS.md](COMMANDS.md) with full flags and examples.**

---

## Use it as an MCP server

The simplest path is to let `cortex install` wire your hosts — without `--hosts`
it registers **Claude Code** and **Cursor** and auto-detects **Codex**,
**OpenCode** and **Pi** when installed (`--global`/`--local` control the scope;
see [COMMANDS](COMMANDS.md#cortex-install--entry-point-command)).

To wire it by hand, point your agent or IDE at the stdio MCP server:

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

The server exposes ten tools: `search`, `explore`, `trace`, `impact`,
`diff_impact`, `files`, `pack_context`, `retrieve`, `status` and
`semantic_search`. They all read local state only.

---

## Keep the index fresh (optional)

You can let the index stay fresh on its own, so the agent never queries stale
state and you never run `cortex sync` by hand:

```bash
cortex hook install         # git hooks mark what changed (never block a commit)
cortex agent-rules install  # tell agents to use cortex (CLAUDE.md + AGENTS.md)
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
  off, telling you what to do (e.g. run `cortex sync`).

Two ideas worth knowing:

- **Staleness.** The index can drift from the code. `status` and every query
  surface `fresh` / `stale` / `unknown` so results are never silently wrong.
- **Retrieve handles.** `pack_context` may return a compact context plus an
  opaque handle (`rh_…`). `retrieve <handle>` rehydrates the original, on
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

- Calls without a resolved import degrade to global name matching (mitigable via optional SCIP import — `cortex scip import`).
- Dynamic/reflective resolution is not treated as proven causality.
- `search` ranks lexically and structurally (always fresh). Semantic
  **embeddings are optional and off-by-default**: run `cortex embed` and use the
  `semantic_search` tool (dense bge-small + hybrid RRF fusion). Vectors are not
  auto-synced — they can go stale, and the tool signals it honestly.

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
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute.
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities.
- [CHANGELOG.md](CHANGELOG.md) — release history.
- `.atlas/contracts/` — frozen MCP/CLI surface and response-state contracts.

---

## License

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
