/**
 * Beads Status
 *
 * Shows the active (claimed/in-progress) bead plus ready-work count in the
 * TUI footer via `ctx.ui.setStatus()`.
 *
 * - On `session_start` and `turn_end`, if a `.beads/` workspace is found,
 *   runs `bd list --status=in_progress --json` (active bead) and
 *   `bd ready --json` (ready count) and renders them as a `beads` status.
 * - No-ops outside a `.beads/` workspace: no `bd` process is spawned there.
 *
 * Configuration (environment):
 *  - `BD_BIN`                path/name of the bd binary (default: `bd`)
 *  - `PI_BEADS_STATUS_DISABLE=1`  disable this extension
 *  - `BEADS_DIR`             honored when set to a `.beads` dir or workspace root
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "beads";
const DISABLE_ENV = "PI_BEADS_STATUS_DISABLE";
const BD_BIN_ENV = "BD_BIN";
const BEADS_DIR_ENV = "BEADS_DIR";
const BD_TIMEOUT_MS = 5_000;

function isDisabled(): boolean {
	const v = process.env[DISABLE_ENV];
	return v === "1" || v?.toLowerCase() === "true";
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

type BdIssue = { id?: unknown; title?: unknown };

async function runBdJson(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
): Promise<unknown> {
	const bd = process.env[BD_BIN_ENV] || "bd";
	const res = await pi.exec(bd, args, { cwd, timeout: BD_TIMEOUT_MS });
	if (res.code !== 0) {
		throw new Error((res.stderr || res.stdout || `bd exited ${res.code}`).trim());
	}
	const out = res.stdout.trim();
	if (!out) {
		return [];
	}
	return JSON.parse(out);
}

function pickActive(issues: unknown): BdIssue | undefined {
	if (!Array.isArray(issues) || issues.length === 0) {
		return undefined;
	}
	// Prefer the most recently updated in-progress issue as "active".
	const sorted = [...issues].sort((a, b) => {
		const au = (a as Record<string, unknown>).updated_at;
		const bu = (b as Record<string, unknown>).updated_at;
		if (typeof au === "string" && typeof bu === "string") {
			return au < bu ? 1 : -1;
		}
		return 0;
	});
	return sorted[0] as BdIssue;
}

function formatStatus(active: BdIssue | undefined, readyCount: number): string {
	const id = typeof active?.id === "string" ? active.id : undefined;
	const title = typeof active?.title === "string" ? active.title : undefined;
	const label = id ? (title ? `${id}: ${truncate(title, 40)}` : id) : "no active bead";
	return `◐ ${label} · ready: ${readyCount}`;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function beadsStatus(pi: ExtensionAPI) {
	if (isDisabled()) {
		return;
	}

	async function refresh(ctx: { cwd: string; hasUI?: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } }): Promise<void> {
		const root = findWorkspaceRoot(ctx.cwd);
		if (!root) {
			return;
		}
		try {
			const [inProgress, ready] = await Promise.all([
				runBdJson(pi, root, ["list", "--status=in_progress", "--json"]),
				runBdJson(pi, root, ["ready", "--json"]),
			]);
			const readyCount = Array.isArray(ready) ? ready.length : 0;
			ctx.ui.setStatus(STATUS_KEY, formatStatus(pickActive(inProgress), readyCount));
		} catch {
			ctx.ui.setStatus(STATUS_KEY, "◐ beads: unavailable");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}
		await refresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}
		await refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// non-UI modes may not support setStatus; ignore
		}
	});
}
