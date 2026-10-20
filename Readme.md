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
| `beads-session` | Binds pi session to claimed bead: `BEADS_ACTOR`, session name, shutdown handoff notes |
| `beads-guard` | Blocks/confirm-guards destructive `bd` shell calls (`edit`, `delete`, reason-less/forced `close`) |
| `beads-tools` | Typed `bd_create` / `bd_update` / `bd_close` / `bd_ready` tools with JSON args |

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

## `beads-session`

- On **`session_start`**, sets `BEADS_ACTOR=pi:<sessionId>` so every `bd`
  invocation this session makes is attributed to the pi session id in
  `bd history`/actor fields (restored on shutdown).
- In a `.beads/` workspace, binds the session to the most recently updated
  in-progress bead and, when the session has no name yet, names it
  `<id>: <title>` via `pi.setSessionName()`.
- On **`session_shutdown`**, appends a resume note to the bound bead with
  session id, session file, shutdown reason, and leaf id, so the next
  session picks up exact state.
- Set `PI_BEADS_SESSION_RENAME=0` to skip renaming,
  `PI_BEADS_SHUTDOWN_NOTES=0` to skip the shutdown note,
  `PI_BEADS_SESSION_DISABLE=1` to disable everything.

## `beads-guard`

- On **`tool_call`** for `bash`/`powershell`, inspects `bd` invocations:
  - `bd edit` — always blocked (opens `$EDITOR` and hangs the agent);
    use `bd update` flags instead.
  - `bd delete`, `bd close` without `--reason`, and `--force` overrides
    require confirmation in TUI sessions and are blocked headless (safe
    default).
- Commands are split on shell separators before analysis, so `bd list; bd
  edit x` is caught too. All other `bd` flows pass through untouched.
- Set `PI_BEADS_GUARD_DISABLE=1` to disable.

## `beads-tools`

- On **`session_start`** in a `.beads/` workspace, registers typed tools:
  - `bd_create(title, description?, type?, priority?, parent?)`
  - `bd_update(id, claim?, status?, assignee?, title?, description?, notes?, append_notes?, priority?)`
  - `bd_close(ids, reason)` — `reason` is required by the schema
  - `bd_ready()`
- Runs `bd` with the workspace root as cwd; results are the CLI output
  with the exit code in `details`.
- Set `PI_BEADS_TOOLS_DISABLE=1` to disable.

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
