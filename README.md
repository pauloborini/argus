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

On the internal benchmark (real engineering tasks, 6 repos):

| Metric | Baseline | Atlas Cortex |
|---|---|---|
| Tool calls | 24 | **14** (−41.7%) |
| Approx. tokens | 76,209 | **8,940** (−88.1%) |
| Average usefulness | — | **4.17 / 5** |

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

Three steps take you from a cold repo to useful answers.

```bash
# 1. Prepare the workspace (creates a local .cortex/ folder)
cortex init

# 2. Build the index (files, symbols, imports, relations)
cortex index

# 3. Ask questions
cortex search "calculateTotal"            # find a symbol fast
cortex explore src/billing.ts --mode file # structured context for a file
```

That's the core loop. After code changes, run `cortex sync` (incremental) and
check `cortex status` for staleness. **Every other command — `trace`,
`impact`, `diff-impact`, `pack-context`, `retrieve` — lives in
[COMMANDS.md](COMMANDS.md) with full flags and examples.**

---

## Use it as an MCP server

Point your agent or IDE at the stdio MCP server:

```json
{
  "mcpServers": {
    "atlas-cortex": {
      "command": "npx",
      "args": ["-y", "atlas-cortex@1.0.0", "serve", "--mcp"]
    }
  }
}
```

The server exposes nine tools: `search`, `explore`, `trace`, `impact`,
`diff_impact`, `files`, `pack_context`, `retrieve`, `status`. They all read
local state only.

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
| Extension | Dart, Kotlin | partial (honest degradation) |

Dart gets first-class structural extraction (classes, mixins, typedefs,
top-level constants, `with`/`on` relations) because of Flutter.

---

## Known limitations

- Calls without a resolved import degrade to global name matching.
- Dart/Kotlin keep explicit partial coverage.
- Dynamic/reflective resolution is not treated as proven causality.
- `search` ranks lexically and structurally — **no embeddings**.

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
