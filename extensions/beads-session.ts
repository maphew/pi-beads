/**
 * Beads Session
 *
 * Binds a pi session to its claimed bead and attributes `bd` audit trails:
 *
 * - On `session_start` in a `.beads/` workspace, sets
 *   `process.env.BEADS_ACTOR` to `pi:<sessionId>` (saving any previous
 *   value), so `bd` history/actor fields carry the pi session id for every
 *   `bd` invocation the agent makes through `pi.exec` (the `bd` CLI defaults
 *   `--actor` to `$BEADS_ACTOR`). Restored on `session_shutdown`.
 * - Optionally names the pi session after the most recently updated
 *   in-progress bead (`<id>: <title>`) via `pi.setSessionName()`, but only
 *   when the session has no name yet — never clobbering an explicit name.
 * - On `session_shutdown`, appends a short resume note to the bound bead
 *   (`bd update <id> --append-notes ...`) with the pi session id, session
 *   file, shutdown reason, and leaf id, so the next session can pick up
 *   exact state. Best-effort: failures are swallowed (shutdown path).
 *
 * No-ops outside a `.beads/` workspace: no `bd` process is spawned there
 * (BEADS_ACTOR is still set, as it is harmless and covers `BEADS_DIR`
 * workspaces resolved later — see below; set `PI_BEADS_SESSION_DISABLE=1`
 * to disable entirely).
 *
 * Configuration (environment):
 *  - `BD_BIN`                 path/name of the bd binary (default: `bd`)
 *  - `PI_BEADS_SESSION_DISABLE=1`  disable this extension
 *  - `PI_BEADS_SESSION_RENAME=0`   skip the session-rename step (default: rename)
 *  - `PI_BEADS_SHUTDOWN_NOTES=0`   skip the shutdown note (default: write it)
 *  - `BEADS_DIR`              honored when set to a `.beads` dir or workspace root
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLE_ENV = "PI_BEADS_SESSION_DISABLE";
const RENAME_ENV = "PI_BEADS_SESSION_RENAME";
const NOTES_ENV = "PI_BEADS_SHUTDOWN_NOTES";
const BD_BIN_ENV = "BD_BIN";
const BEADS_DIR_ENV = "BEADS_DIR";
const ACTOR_ENV = "BEADS_ACTOR";
const BD_TIMEOUT_MS = 5_000;

function isDisabled(): boolean {
	const v = process.env[DISABLE_ENV];
	return v === "1" || v?.toLowerCase() === "true";
}

function isOff(env: string): boolean {
	const v = process.env[env];
	return v === "0" || v?.toLowerCase() === "false";
}

/** Walk up from `start` looking for a `.beads/` directory. */
function findWorkspaceRoot(start: string): string | undefined {
	const beadsDir = process.env[BEADS_DIR_ENV];
	if (beadsDir) {
		const root = path.basename(beadsDir) === ".beads" ? path.dirname(beadsDir) : beadsDir;
		if (fs.existsSync(path.join(root, ".beads"))) {
			return root;
		}
	}

	let dir = path.resolve(start);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".beads"))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

type BdIssue = {
	id?: unknown;
	title?: unknown;
	status?: unknown;
	updated_at?: unknown;
};

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function beadsSession(pi: ExtensionAPI) {
	if (isDisabled()) {
		return;
	}

	let previousActor: string | undefined;
	let actorSet = false;
	let boundBead: string | undefined;
	let workspace: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// Attribute all bd calls in this session to the pi session id.
		let sessionId = "unknown";
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			// keep "unknown"
		}
		if (!actorSet) {
			previousActor = process.env[ACTOR_ENV];
			actorSet = true;
		}
		process.env[ACTOR_ENV] = `pi:${sessionId}`;

		workspace = findWorkspaceRoot(ctx.cwd);
		boundBead = undefined;
		if (!workspace) {
			return;
		}

		// Bind to the claimed bead: most recently updated in-progress issue.
		try {
			const bd = process.env[BD_BIN_ENV] || "bd";
			const res = await pi.exec(bd, ["list", "--status=in_progress", "--json"], {
				cwd: workspace,
				timeout: BD_TIMEOUT_MS,
			});
			if (res.code !== 0) {
				return;
			}
			const issues = JSON.parse(res.stdout.trim() || "[]") as BdIssue[];
			if (!Array.isArray(issues) || issues.length === 0) {
				return;
			}
			const sorted = [...issues].sort((a, b) =>
				typeof a.updated_at === "string" && typeof b.updated_at === "string"
					? (a.updated_at < b.updated_at ? 1 : -1)
					: 0,
			);
			const top = sorted[0];
			if (typeof top.id !== "string") {
				return;
			}
			boundBead = top.id;
			if (!isOff(RENAME_ENV) && typeof top.title === "string") {
				try {
					if (ctx.sessionManager.getSessionName() === undefined) {
						pi.setSessionName(`${top.id}: ${truncate(top.title, 50)}`);
					}
				} catch {
					// rename is cosmetic; ignore
				}
			}
		} catch {
			// binding is best-effort; ignore
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		try {
			if (!isOff(NOTES_ENV) && boundBead && workspace) {
				let sessionId = "unknown";
				let sessionFile = "";
				let leafId = "";
				try {
					sessionId = ctx.sessionManager.getSessionId();
				} catch {
					// keep defaults
				}
				try {
					sessionFile = ctx.sessionManager.getSessionFile() ?? "";
				} catch {
					// keep defaults
				}
				try {
					leafId = ctx.sessionManager.getLeafId() ?? "";
				} catch {
					// keep defaults
				}
				const parts = [
					`pi session ${sessionId} ended (${event.reason})`,
					sessionFile ? `file: ${sessionFile}` : "",
					leafId ? `leaf: ${leafId}` : "",
				].filter(Boolean);
				const bd = process.env[BD_BIN_ENV] || "bd";
				await pi.exec(bd, ["update", boundBead, "--append-notes", parts.join("; ")], {
					cwd: workspace,
					timeout: BD_TIMEOUT_MS,
				});
			}
		} catch {
			// shutdown path: never throw
		} finally {
			if (actorSet) {
				if (previousActor === undefined) {
					delete process.env[ACTOR_ENV];
				} else {
					process.env[ACTOR_ENV] = previousActor;
				}
				actorSet = false;
			}
			boundBead = undefined;
			workspace = undefined;
		}
	});
}
