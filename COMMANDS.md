<!-- Language: **English** · [Português](COMMANDS.pt-BR.md) -->

# Argus — Command reference

The complete, no-prose list of commands. For *what it is* and *why*, read the
**[README](README.md)**.

All examples assume the `argus` binary (from `npm install -g argus`).
Without a global install, prefix any command with `npx argus …`.

## Conventions

- Every tool prints compact **JSON** to stdout (machine-friendly by default).
- Core shared field: `state` (`sucesso` · `ambigua` · `parcial` · `stale` · `falha`).
  Errors also include `message` with an `E_*` / `W_*` code. Fields `confidence`,
  `limitations[]`, and `staleness_hint` (with a `STALE_*` code prefix) appear only in
  `--detailed` mode.
- Exit code is non-zero only when `state` is `falha`.
- Commands are scriptable: pipe stdout into `jq` freely.

**Global flags** (work before any subcommand):

| Flag | Effect |
|------|--------|
| `--pretty` | Indent JSON for human reading (~30–40 % more tokens) |
| `--detailed` | Full envelope: `confidence`, `limitations[]`, `staleness_hint` in prose |

---

## Lifecycle

### `argus install` ⭐ (entry-point command)
Zero-touch wiring of a repository, in **one command**: prepares the workspace,
builds the index, writes the agent rules (CLAUDE.md/AGENTS.md), registers the
MCP server in detected hosts and registers the repo with the auto-sync daemon
(with an auto-start user service). Idempotent.

Without `--hosts`, it wires **Claude Code** and **Cursor** always (project
idiom) and **auto-detects** Codex, OpenCode, Pi, Antigravity, ZCode and VS Code when
installed on this machine (binary on PATH or config directory present).

```bash
argus install                     # full wiring (auto-detects hosts)
argus install --no-daemon         # index + MCP only (no daemon/service)
argus install --no-mcp            # don't register MCP in hosts
argus install --no-memory         # don't initialize .argus/memory
argus install --hosts claude-code,codex  # restrict MCP hosts (CSV)
argus install --global            # register MCP globally (all projects)
argus install --local             # register MCP in this repo only
argus install --scope global      # same as --global
argus install --scope local       # same as --local
argus install --with-hooks        # add git hooks as a daemon-down fallback
```

**Supported hosts and where each registers the MCP:**

| Host | Mechanism | Default scope | Config |
|------|-----------|---------------|--------|
| `claude-code` | JSON `mcpServers` | local (repo) | `.mcp.json` |
| `cursor` | JSON `mcpServers` | local (repo) | `.cursor/mcp.json` |
| `codex` | CLI `codex mcp add/remove` | global | `~/.codex/config.toml` (managed by Codex) |
| `opencode` | JSON `mcp`/`type:local` | global | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME`) or repo |
| `pi` | JSON `mcpServers` | global | `~/.pi/agent/mcp.json` (`PI_CODING_AGENT_DIR`) or repo |
| `antigravity` | JSON `mcpServers` | global | `~/.gemini/antigravity-ide/mcp_config.json` (`ANTIGRAVITY_CONFIG_DIR`) |
| `zcode` | Plugin filesystem + JSON `mcpServers` | global | `~/.zcode/cli/plugins/cache/argus/<version>/.zcode-plugin/plugin.json` (`ZCODE_CONFIG_HOME`) |
| `vscode` | JSON `mcpServers` | local (repo) | `.vscode/mcp.json` (`VSCODE_CONFIG_HOME`) |

In global mode the MCP is registered with an **absolute path** (cwd-independent),
valid across all projects. Existing config is always **merged** — other user
servers are preserved. Codex is wired through its own CLI (`codex mcp add`),
preserving `config.toml` comments; if `codex` is not on PATH the host is reported
as "not detected" without a hard failure.

After this you just code — the daemon keeps the index fresh on its own.

### `argus uninstall`
Reverts the repo wiring: removes the MCP registration from hosts (all scopes by
default — global + local), the agent-rules block, git hooks and the daemon
registration. When the **last workspace** is uninstalled, the auto-start user
service (launchd/systemd) is also removed. `--purge` also removes `.argus/`.

Use `--scope` to limit cleanup to a single scope, `--local`/`--global` as
shorthand, or `--hosts` to target specific hosts.

```bash
argus uninstall                     # full revert (all hosts, all scopes)
argus uninstall --global            # clear only the global MCP registration
argus uninstall --local             # clear only this repo's MCP registration
argus uninstall --scope global      # same as --global
argus uninstall --hosts codex       # clear specific hosts only (CSV)
argus uninstall --hosts opencode --scope global  # clear opencode global only
argus uninstall --purge             # also removes .argus/
```

### `argus init`
Low-level primitive. Prepares the workspace — creates `.argus/` in the target
repo (`workspace.json`, `file-manifest.json`). Idempotent. Prefer
`argus install` for full wiring.

```bash
argus init
```

### `argus index`
Full rebuild of the file manifest and the SQLite + FTS structural index
(`.argus/index.db`). Run once after `init`, and again whenever you want a
clean rebuild.

```bash
argus index
```

### `argus sync`
Incremental update — only the changed delta. Cheaper than `index`. Fails with
`E_INDEX_MISSING` if no manifest exists yet (run `argus index` first).

```bash
argus sync
argus sync --since HEAD~1   # git-delta: skip the full filesystem walk
argus sync --full           # force a full walk (ignore git-delta/dirty-flag)
```

| Flag | Meaning |
|---|---|
| `--since <ref>` | Resolve the delta via `git diff` since `<ref>`, skipping the full walk. Falls back to a full walk if git is absent or the ref is invalid. |
| `--full` | Force a full filesystem walk, ignoring git-delta and the dirty-flag. |

Output reports the path taken — `via full` · `via git-delta` · `via dirty-flag`
· `via watch` (explicit-paths delta from the daemon) — and, when a dirty-flag
was consumed, the number of pending paths.

### `argus embed`
Generate semantic embeddings of the structural index — **optional and
off-by-default**. Powers the `semantic_search` tool. Local bge-small model
(downloads on first use, transformers.js cache), int8-quantized vectors stored
in the same SQLite. **Not auto-synced**: re-run after meaningful changes (a full
`argus index` clears the vectors; an incremental `argus sync` leaves them
stale, signalled at search time).

```bash
argus embed
argus embed --batch 64   # inference batch size (default 32)
```

| Flag | Meaning |
|---|---|
| `--batch <n>` | Symbols per inference batch. |

### `argus memory`
Local knowledge vault under `.argus/memory/`.

```bash
argus memory init
printf "# nota\n" | argus memory remember --stdin
argus memory remember "decisão" --type decision --tag s11 --link src/cli.ts
argus memory sync
argus memory embed
argus memory search "nota"
argus memory doctor
argus memory rebuild
argus memory dream
```

Memory uses the same local-first runtime and int8 embedding strategy as code
search. Legacy `.athena/athena-vault.db` is copied only as
`.argus/memory/legacy-athena-vault.db`; runtime data is rebuilt into
`.argus/memory/memory.db`.

### `argus scip import`
Import precise edges from a SCIP index file — **optional and off-by-default**.
SCIP (Sourcegraph Code Intelligence Protocol) provides globally-stable symbol IDs
with accurate go-to-def/find-refs. When imported, SCIP edges override heuristic
tree-sitter edges for covered symbol pairs. Requires `argus index` first; re-run
after reindex (reindex clears SCIP edges).

```bash
argus scip import                     # default: <workspace>/index.scip
argus scip import ./build/index.scip  # explicit path
```

| Argument | Meaning |
|---|---|
| `[path]` | Path to `index.scip` file. Default: `<workspace>/index.scip`. |

Output: count of imported edges, matched/missing files, covered symbols.
SCIP requires a build step in CI (`scip-typescript`, `scip-python`, etc.) — gain
is conditional on the repo emitting `index.scip`.

### `argus status`
Health and staleness of the local index.

```bash
argus status
argus status --path src/billing
```

| Flag | Meaning |
|---|---|
| `--path <path>` | Inspect a subpath / workspace. |

Key output: `staleness` (`fresh` · `stale` · `unknown`), `pending_files_count`,
`coverage_by_language`, `storage_backend`, `schema_version`.

---

## Retrieval

### `argus search <query>`
Lexical + structural symbol search over the local FTS index.

```bash
argus search "calculateTotal"
argus search "calculate" --scope src/ --kind function --limit 5
argus search "runSync" --format tsv | cut -f1,2   # pipe-friendly TSV
```

| Flag | Meaning |
|---|---|
| `--scope <path>` | Restrict candidates to a path/dir. |
| `--kind <kind>` | Restrict by symbol kind (`function`, `class`, …). |
| `--limit <n>` | Max candidates. |
| `--format <fmt>` | `concise` (default) · `detailed` · `tsv` (tab-separated, ideal for pipes). |

Each candidate: `id`, `kind`, `name`, `path`, `start_line`, `end_line`,
`score`, `match_reason`. `start_line`/`end_line` distinguish same-named symbols
in one file and let you jump straight to them.

TSV columns: `name`, `path`, `kind`, `line`, `score`. Truncates at 50 results
(note goes to stderr); add `--limit` to narrow the set first.

### `argus semantic-search <query>`
Search by **meaning** via embeddings (local bge-small), fused with lexical via
RRF. Use when `search` comes back empty or intent doesn't match literal names —
e.g. *"OS file-watcher limit reached"* finds `watcherExhaustionHint` without the
term in its name. Requires `argus embed` first (off-by-default); with no
vectors it degrades honestly (`W_EMBEDDINGS_UNAVAILABLE`) and falls back to
lexical results.

```bash
argus semantic-search "where do we handle the OS file-watcher limit"
argus semantic-search "combine lexical and dense ranking" --mode dense --limit 5
```

| Flag | Meaning |
|---|---|
| `--mode <mode>` | `dense` (vectors only) · `hybrid` (RRF fusion with lexical, default). |
| `--domain <domain>` | `code` (default) · `memory` · `all`. |
| `--scope <path>` | Restrict candidates to a path/dir. |
| `--kind <kind>` | Restrict by symbol kind. |
| `--limit <n>` | Max candidates. |

Same candidate shape as `search`, with `match_reason` ∈ `semantic` · `lexical` ·
`hybrid`. `state` may be `stale` (`W_EMBEDDINGS_STALE`) when the index moved
ahead of the last `embed` — results still served with the warning.

### `argus files`
List the indexed structure of the workspace.

```bash
argus files
argus files --pattern src --max-depth 3
argus files --format tsv | awk -F'\t' '$3 > 10'   # files with >10 symbols
```

| Flag | Meaning |
|---|---|
| `--pattern <pattern>` | Substring filter on paths. |
| `--max-depth <n>` | Max path depth. |
| `--format <fmt>` | `concise` (default) · `detailed` · `tsv` (tab-separated, ideal for pipes). |

Output: a `tree` of paths with `symbol_counts`.

TSV columns: `path`, `language`, `symbol_count`. Truncates at 50 results
(note goes to stderr).

### `argus explore <target>`
Composite structural context for a symbol, file, or topic — central symbols,
imports, relevant files, and line-ranged snippets in one shot. This is the
go-to tool for "understand this area".

```bash
argus explore src/mcp/engine.ts --mode file
argus explore calculateTotal --mode symbol --depth 2
argus explore "billing" --mode topic --include-tests
```

| Flag | Meaning |
|---|---|
| `--mode <mode>` | `symbol` · `file` · `topic`. |
| `--depth <n>` | Exploration depth (short). |
| `--include-tests` | Include test files when relevant. |
| `--budget <n>` | Internal candidate budget. |

### `argus trace --from <target>`
Likely flow between indexed points, with explicit uncertainty.

```bash
argus trace --from calculateTotal
argus trace --from calculateTotal --to renderInvoice --direction forward --max-hops 4
```

| Flag | Meaning |
|---|---|
| `--from <target>` | **Required.** Source symbol or file. |
| `--to <target>` | Destination symbol or file. |
| `--direction <dir>` | `forward` · `backward` · `both`. |
| `--max-hops <n>` | Max hops. |

Output: `paths`, `files`, `symbols`, `uncertainty_points`.

### `argus impact <target>`
Likely blast radius of changing a symbol or file.

```bash
argus impact calculateTotal --direction dependents
argus impact src/billing.ts --depth 2 --include-tests --summary-only
```

| Flag | Meaning |
|---|---|
| `--direction <dir>` | `dependents` · `dependencies` · `both`. |
| `--depth <n>` | Max impact depth. |
| `--include-tests` | Include test files. |
| `--summary-only` | Return aggregates / risk summary only. |

Output: `direct_affected`, `indirect_affected`, `files`, `tests`,
`risk_summary`.

### `argus diff-impact`
Likely impact of the current Git diff — changed symbols and affected tests.

```bash
argus diff-impact --scope all
argus diff-impact --scope compare --base-ref main
```

| Flag | Meaning |
|---|---|
| `--scope <scope>` | `unstaged` · `staged` · `all` · `compare`. |
| `--base-ref <ref>` | Git base when `--scope compare`. |

Output: `changed_files`, `changed_symbols`, `affected_areas`,
`affected_tests`, `risk_summary`.

---

## Context packing

### `argus pack-context`
Pack short, useful context for the model. May return a `retrieve_handle` when
the budget forces truncation.

```bash
argus pack-context \
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

### `argus retrieve <handle>`
Rehydrate the original content stored behind a `retrieve_handle`. Confined to
the same workspace; handle format is `rh_<16 hex>`.

```bash
argus retrieve rh_0123456789abcdef
```

---

## MCP server

### `argus serve --mcp`
Start the stdio MCP server. Exposes nine tools (`search`, `explore`, `trace`,
`impact`, `diff_impact`, `files`, `pack_context`, `retrieve`, `status`).

```bash
argus serve --mcp
argus serve --mcp --no-auto-sync   # disable auto-sync before tool calls
```

| Flag | Meaning |
|---|---|
| `--mcp` | **Required.** Start the stdio MCP server. |
| `--no-auto-sync` | Disable the automatic incremental sync before each tool call. |

By default the server consumes the dirty-flag and runs an incremental sync
before answering, so the agent always queries a fresh index. Sync errors never
crash the server — the result degrades to `parcial` + `staleness_hint`.

Configure your agent/IDE (see [README → Use it as an MCP server](README.md#use-it-as-an-mcp-server)).

---

## Auto-sync daemon

The daemon watches the filesystem (FSEvents/inotify) and keeps the index fresh
in real time — no manual command, editor-agnostic. A single user daemon watches
**all** repos registered via `argus install`. Bursts of saves or branch switches
are coalesced into a single incremental sync (explicit-paths delta, never a full
walk).

```bash
argus daemon status     # watched workspaces and each one's last sync
argus daemon start      # run in background (the service usually does this)
argus daemon stop
argus daemon restart
argus daemon reload     # reload the registry without restarting (after a new install)
```

`argus install` already installs and starts the user service (launchd on macOS,
systemd --user on Linux) with login auto-start. To manage the service directly:

```bash
argus daemon install-service
argus daemon uninstall-service
```

When the **last workspace** is uninstalled (`argus uninstall`), the user service
is automatically removed — no manual cleanup needed.

If the daemon is stopped the index does **not** go stale: the optional git hooks
and the MCP server's lazy auto-sync remain as a safety net.

---

## Low-friction sync

Keep the index fresh without thinking about it: the daemon syncs on each event;
as a fallback, git hooks mark what changed and the MCP server syncs lazily before
answering. Nothing blocks your commit.

### `argus hook install` / `argus hook uninstall`
Install (or remove) git hooks (`post-commit`, `post-merge`, `post-checkout`)
that **only mark the index dirty** — they never run a sync, so commits never
stall. The binary path is embedded in the script (works in GUI git clients and
CI). Idempotent; pre-existing hooks are preserved (argus writes a delimited
block).

```bash
argus hook install
argus hook uninstall
```

### `argus agent-rules install` / `argus agent-rules uninstall`
Write (or remove) a delimited Argus block in `CLAUDE.md` and `AGENTS.md`,
instructing agents to use the argus tools and trust the auto-sync. Append-only
and idempotent — your existing content is never overwritten.

```bash
argus agent-rules install
argus agent-rules uninstall
```

### `argus mark-dirty`
Internal command invoked by the installed hooks. Marks the index dirty from a
git event; if the git delta cannot be resolved, marks `force_full` so the next
sync falls back to a full walk. You normally never call this by hand.

```bash
argus mark-dirty --since HEAD~1
```

---

## Development & release

Run from the monorepo root.

| Command | Purpose |
|---|---|
| `npm run build` | Compile `packages/argus`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Unit tests (vitest). |
| `npm run lint` | ESLint. |
| `npm run validate` | typecheck + test + lint + build. |
| `npm run benchmark:mvp` | Internal benchmark → `.argus/benchmark/latest/`. |
| `npm run smoke:package` | Install & exercise the tarball in a clean dir. |
| `npm run homologate` | Validate external local repos (real retrieval probe). |
| `npm run release:check` | Assert version consistency across root/runtime/plugin. |
| `npm run release:eval` | Aggregated memory/privacy/performance evidence with blocking verdict → `.argus/release-evaluation/latest.json`. |

Homologation needs at least two local repo paths. Set `ARGUS_HOMOLOGATION_REPOS=repoA:repoB` when defaults are missing.

Release evaluation (S08) covers aggregated retrieval/memory, local-first privacy, degradation without embeddings/LLM, dream dry-run, and the 12-tool MCP surface (`remember`/`recall`). Recorded performance is indicative only — no SLA. A non-`passed` verdict exits non-zero.

Tags `v*` run CI, tarball smoke, npm publish with provenance, and a GitHub
Release with `SHA256SUMS`. The tag version must match root, runtime and plugin.

---

## Recovery cheatsheet

| Symptom | Fix |
|---|---|
| Index stale | `argus sync` |
| Index missing/corrupted | delete `.argus/index.db`, then `argus index` |
| Invalid workspace | keep code, delete `.argus/`, then `argus init` + `argus index` |
| Corrupted handle | re-pack with `argus pack-context` (don't edit `.argus/packed-handles`) |

> Project files are never modified by recovery — only `.argus/` is touched.
