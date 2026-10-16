/**
 * Beads Prime
 *
 * Injects live Beads (`bd prime`) workflow context into the system prompt for
 * Batches-compatible harnesses that have no bd SessionStart hook (e.g. pi).
 *
 * Where Claude Code, Cursor, and Codex call `bd prime --hook-json` from a
 * SessionStart hook, pi has no such hook. This extension closes that gap:
 *
 *  - on `session_start`, if a `.beads/` workspace is found, it runs
 *    `bd prime --hook-json` and caches the returned `additionalContext`;
 *  - on `before_agent_start`, it adds that context as a `<beads>` system-prompt
 *    section, so the live agent.profile / git-authority policy and workflow
 *    rules survive context compaction and are always current;
 *  - `/beads` reports or refreshes the injected context.
 *
 * It is deliberately generic: it no-ops in repositories without `.beads/` and
 * executes no `bd` process there, so it is safe to install globally and use
 * across every machine and every Beads workspace.
 *
 * Configuration (environment):
 *  - `BD_BIN`               path/name of the bd binary (default: `bd`)
 *  - `PI_BEADS_PRIME_DISABLE=1`  disable this extension
 *  - `BEADS_DIR`            honored when set to a `.beads` dir or workspace root
 *
 * Install: `pi install git:github.com/maphew/pi-beads` (npm once published),
 * or place this file in `<agent-dir>/extensions/` (user) or `.pi/extensions/`
 * (project).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = "beads";
const DISABLE_ENV = "PI_BEADS_PRIME_DISABLE";
const BD_BIN_ENV = "BD_BIN";
const BD_PRIME_TIMEOUT_MS = 10_000;

function isDisabled(): boolean {
	const v = process.env[DISABLE_ENV];
	return v === "1" || v?.toLowerCase() === "true";
}

/** Walk up from `start` looking for a `.beads/` directory. */
function findWorkspaceRoot(start: string): string | undefined {
	const beadsDir = process.env.BEADS_DIR;
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

type PrimeResult = { context?: string; error?: string };

/** Run `bd prime`, preferring the hook-JSON envelope, falling back to plain text. */
async function runBdPrime(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<PrimeResult> {
	const bd = process.env[BD_BIN_ENV] || "bd";
	const opts = { cwd, timeout: BD_PRIME_TIMEOUT_MS, signal };

	let res: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		res = await pi.exec(bd, ["prime", "--hook-json"], opts);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}

	// Older bd builds may not support --hook-json; retry with plain output.
	if (res.code !== 0) {
		try {
			const plain = await pi.exec(bd, ["prime"], opts);
			if (plain.code === 0 && plain.stdout.trim()) {
				return { context: plain.stdout.trim() };
			}
		} catch {
			// fall through to the original error
		}
		return { error: (res.stderr || res.stdout || `bd prime exited with code ${res.code}`).trim() };
	}

	const out = res.stdout.trim();
	if (!out) {
		return { error: "bd prime produced no output" };
	}

	try {
		const parsed = JSON.parse(out) as {
			hookSpecificOutput?: { additionalContext?: unknown };
		};
		const text = parsed.hookSpecificOutput?.additionalContext;
		if (typeof text === "string" && text.trim()) {
			return { context: text.trim() };
		}
	} catch {
		// Not JSON — use raw stdout below.
	}

	return { context: out };
}

export default function beadsPrime(pi: ExtensionAPI) {
	if (isDisabled()) {
		return;
	}

	let context: string | undefined;
	let workspace: string | undefined;
	let lastError: string | undefined;

	async function refresh(start: string, signal?: AbortSignal): Promise<void> {
		workspace = findWorkspaceRoot(start);
		context = undefined;
		lastError = undefined;
		if (!workspace) {
			return;
		}
		const result = await runBdPrime(pi, workspace, signal);
		context = result.context;
		lastError = result.error;
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx.cwd);
		if (!workspace || !ctx.hasUI) {
			return;
		}
		if (context) {
			ctx.ui.notify(`Beads: loaded bd prime context from ${workspace}`, "info");
		} else if (lastError) {
			ctx.ui.notify(`Beads: bd prime failed: ${lastError}`, "warning");
		}
	});

	pi.on("before_agent_start", (event) => {
		if (context) {
			event.systemPromptOptions.sections[SECTION] = context;
		}
	});

	pi.on("session_shutdown", () => {
		context = undefined;
		workspace = undefined;
		lastError = undefined;
	});

	pi.registerCommand("beads", {
		description: "Report or refresh the injected Beads (bd prime) context",
		handler: async (_args, ctx) => {
			await refresh(ctx.cwd);
			if (!workspace) {
				ctx.ui.notify("Beads: no .beads workspace found from here", "warning");
				return;
			}
			if (!context) {
				ctx.ui.notify(`Beads: bd prime failed: ${lastError ?? "unknown error"}`, "error");
				return;
			}
			const profile = /agent\.profile=(\S+)/.exec(context)?.[1];
			ctx.ui.notify(
				`Beads: context loaded from ${workspace}` +
					(profile ? ` (profile: ${profile})` : "") +
					` — ${context.length} chars`,
				"info",
			);
		},
	});
}
