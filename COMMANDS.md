<!-- Language: **English** · [Português](COMMANDS.pt-BR.md) -->

# Atlas Cortex — Command reference

The complete, no-prose list of commands. For *what it is* and *why*, read the
**[README](README.md)**.

All examples assume the `cortex` binary (from `npm install -g atlas-cortex`).
Without a global install, prefix any command with `npx atlas-cortex …`.

## Conventions

- Every tool prints **JSON** to stdout.
- Shared fields: `state` (`sucesso` · `ambigua` · `parcial` · `stale` ·
  `falha`), `confidence` (`high` · `medium` · `low`), and, when relevant,
  `limitations[]` and `staleness_hint`.
- Exit code is non-zero only when `state` is `falha`.
- Commands are scriptable: pipe stdout into `jq` freely.

---

## Lifecycle

### `cortex init`
Prepare the workspace. Creates `.cortex/` in the target repo
(`workspace.json`, `file-manifest.json`). Idempotent — re-running warns instead
of failing.

```bash
cortex init
```

### `cortex index`
Full rebuild of the file manifest and the SQLite + FTS structural index
(`.cortex/index.db`). Run once after `init`, and again whenever you want a
clean rebuild.

```bash
cortex index
```

### `cortex sync`
Incremental update — only the changed delta. Cheaper than `index`. Fails with
`E_INDEX_MISSING` if no manifest exists yet (run `cortex index` first).

```bash
cortex sync
```

### `cortex status`
Health and staleness of the local index.

```bash
cortex status
cortex status --path src/billing
```

| Flag | Meaning |
|---|---|
| `--path <path>` | Inspect a subpath / workspace. |

Key output: `staleness` (`fresh` · `stale` · `unknown`), `pending_files_count`,
`coverage_by_language`, `storage_backend`, `schema_version`.

---

## Retrieval

### `cortex search <query>`
Lexical + structural symbol search over the local FTS index.

```bash
cortex search "calculateTotal"
cortex search "calculate" --scope src/ --kind function --limit 5
```

| Flag | Meaning |
|---|---|
| `--scope <path>` | Restrict candidates to a path/dir. |
| `--kind <kind>` | Restrict by symbol kind (`function`, `class`, …). |
| `--limit <n>` | Max candidates. |

Each candidate: `id`, `kind`, `name`, `path`, `start_line`, `end_line`,
`score`, `match_reason`. `start_line`/`end_line` distinguish same-named symbols
in one file and let you jump straight to them.

### `cortex files`
List the indexed structure of the workspace.

```bash
cortex files
cortex files --pattern src --max-depth 3
```

| Flag | Meaning |
|---|---|
| `--pattern <pattern>` | Substring filter on paths. |
| `--max-depth <n>` | Max path depth. |

Output: a `tree` of paths with `symbol_counts`.

### `cortex explore <target>`
Composite structural context for a symbol, file, or topic — central symbols,
imports, relevant files, and line-ranged snippets in one shot. This is the
go-to tool for "understand this area".

```bash
cortex explore src/mcp/engine.ts --mode file
cortex explore calculateTotal --mode symbol --depth 2
cortex explore "billing" --mode topic --include-tests
```

| Flag | Meaning |
|---|---|
| `--mode <mode>` | `symbol` · `file` · `topic`. |
| `--depth <n>` | Exploration depth (short). |
| `--include-tests` | Include test files when relevant. |
| `--budget <n>` | Internal candidate budget. |

### `cortex trace --from <target>`
Likely flow between indexed points, with explicit uncertainty.

```bash
cortex trace --from calculateTotal
cortex trace --from calculateTotal --to renderInvoice --direction forward --max-hops 4
```

| Flag | Meaning |
|---|---|
| `--from <target>` | **Required.** Source symbol or file. |
| `--to <target>` | Destination symbol or file. |
| `--direction <dir>` | `forward` · `backward` · `both`. |
| `--max-hops <n>` | Max hops. |

Output: `paths`, `files`, `symbols`, `uncertainty_points`.

### `cortex impact <target>`
Likely blast radius of changing a symbol or file.

```bash
cortex impact calculateTotal --direction dependents
cortex impact src/billing.ts --depth 2 --include-tests --summary-only
```

| Flag | Meaning |
|---|---|
| `--direction <dir>` | `dependents` · `dependencies` · `both`. |
| `--depth <n>` | Max impact depth. |
| `--include-tests` | Include test files. |
| `--summary-only` | Return aggregates / risk summary only. |

Output: `direct_affected`, `indirect_affected`, `files`, `tests`,
`risk_summary`.

### `cortex diff-impact`
Likely impact of the current Git diff — changed symbols and affected tests.

```bash
cortex diff-impact --scope all
cortex diff-impact --scope compare --base-ref main
```

| Flag | Meaning |
|---|---|
| `--scope <scope>` | `unstaged` · `staged` · `all` · `compare`. |
| `--base-ref <ref>` | Git base when `--scope compare`. |

Output: `changed_files`, `changed_symbols`, `affected_areas`,
`affected_tests`, `risk_summary`.

---

## Context packing

### `cortex pack-context`
Pack short, useful context for the model. May return a `retrieve_handle` when
the budget forces truncation.

```bash
cortex pack-context \
  --sources utils.ts,src/billing.ts \
  --goal "understand the refactor" \
  --token-budget 400 \
  --style balanced
```

| Flag | Meaning |
|---|---|
| `--sources <list>` | **Required.** CSV of paths, symbols, or handles. |
| `--goal <text>` | **Required.** What the pack is for. |
| `--token-budget <n>` | **Required.** Approx. max pack size. |
| `--style <style>` | `brief` · `balanced` · `deep`. |

### `cortex retrieve <handle>`
Rehydrate the original content stored behind a `retrieve_handle`. Confined to
the same workspace; handle format is `rh_<16 hex>`.

```bash
cortex retrieve rh_0123456789abcdef
```

---

## MCP server

### `cortex serve --mcp`
Start the stdio MCP server. Exposes nine tools (`search`, `explore`, `trace`,
`impact`, `diff_impact`, `files`, `pack_context`, `retrieve`, `status`).

```bash
cortex serve --mcp
```

Configure your agent/IDE (see [README → Use it as an MCP server](README.md#use-it-as-an-mcp-server)).

---

## Development & release

Run from the monorepo root.

| Command | Purpose |
|---|---|
| `npm run build` | Compile `packages/cortex`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Unit tests (vitest). |
| `npm run lint` | ESLint. |
| `npm run validate` | typecheck + test + lint + build. |
| `npm run benchmark:mvp` | Internal benchmark → `.atlas/benchmark/latest/`. |
| `npm run smoke:package` | Install & exercise the tarball in a clean dir. |
| `npm run homologate` | Validate external local repos (real retrieval probe). |
| `npm run release:check` | Assert version consistency across root/runtime/plugin. |

Tags `v*` run CI, tarball smoke, npm publish with provenance, and a GitHub
Release with `SHA256SUMS`. The tag version must match root, runtime and plugin.

---

## Recovery cheatsheet

| Symptom | Fix |
|---|---|
| Index stale | `cortex sync` |
| Index missing/corrupted | delete `.cortex/index.db`, then `cortex index` |
| Invalid workspace | keep code, delete `.cortex/`, then `cortex init` + `cortex index` |
| Corrupted handle | re-pack with `cortex pack-context` (don't edit `.cortex/packed-handles`) |

> Project files are never modified by recovery — only `.cortex/` is touched.
