# @maphew/pi-beads

Pi extensions for [Beads](https://github.com/gastownhall/beads) (`bd`).

Pi has no bd `SessionStart` hook, unlike Claude Code, Cursor, and Codex. These
extensions close that gap so a pi agent always has live Beads workflow context
and the active git-authority policy, without having to remember to run `bd prime`
itself.

## Extensions

| Extension | What it does |
| --- | --- |
| `beads-prime` | Injects live `bd prime` context into the system prompt |
| `beads-status` | Shows active bead + ready count in the TUI footer |

## Install

```bash
pi install git:github.com/maphew/pi-beads
```

or, once published to npm:

```bash
pi install npm:@maphew/pi-beads
```

For a single run without installing:

```bash
pi -e git:github.com/maphew/pi-beads
```

## `beads-prime`

- On **`session_start`**, finds the nearest `.beads/` workspace (walking up from
  the current directory, honoring `BEADS_DIR`) and runs
  `bd prime --hook-json`, caching `hookSpecificOutput.additionalContext`.
- On **`before_agent_start`**, adds that text as a `<beads>` system-prompt
  section, so the live `agent.profile` / git-authority policy and workflow rules
  stay current and survive context compaction.
- No-ops in repositories without a `.beads/` workspace: no `bd` process is
  spawned there, so it is safe to install globally and use everywhere.

The `/beads` command reports or refreshes the injected context.

## `beads-status`

- On **`session_start`** and **`turn_end`**, finds the nearest `.beads/`
  workspace (walking up from the current directory, honoring `BEADS_DIR`)
  and renders the most recently updated in-progress bead plus the `bd ready`
  count via `ctx.ui.setStatus()`, e.g. `◐ pi-kilo-xg2.1: show active… · ready: 3`.
- Clears the status on **`session_shutdown`**.
- No-ops outside a `.beads/` workspace and in non-UI modes (print/RPC):
  no `bd` process is spawned there.

### Configuration

| Env var | Effect |
| --- | --- |
| `BD_BIN` | Path/name of the `bd` binary (default: `bd`) |
| `PI_BEADS_STATUS_DISABLE=1` | Disable this extension |
| `BEADS_DIR` | Honored when set to a `.beads` dir or workspace root |

### Configuration

| Env var | Effect |
| --- | --- |
| `BD_BIN` | Path/name of the `bd` binary (default: `bd`) |
| `PI_BEADS_PRIME_DISABLE=1` | Disable this extension |
| `BEADS_DIR` | Honored when set to a `.beads` dir or workspace root |

## Requirements

The `bd` CLI must be installed and on `PATH` (or set `BD_BIN`).

## Development

The extensions are plain TypeScript with no build step. Load a working copy
directly:

```bash
pi -e ./extensions/beads-prime.ts
```

## License

MIT. See [LICENSE](./LICENSE).
