/**
 * Beads Guard
 *
 * Guardrails against destructive `bd` invocations issued through the `bash`
 * (or `powershell`) tool:
 *
 * - `bd edit` opens `$EDITOR` and blocks the agent — always blocked, with a
 *   reason pointing at `bd update` flags instead. Never confirmed: it is
 *   never right for an agent.
 * - `bd delete` — requires confirmation in TUI sessions, blocked headless.
 * - `bd close` without `--reason`/`-r` — requires confirmation in TUI
 *   sessions (a reason-less close drops audit context), blocked headless.
 * - `bd update --force` / `bd close --force` — overrides another actor's
 *   live claim or open blockers; requires confirmation in TUI, blocked
 *   headless.
 * - Everything else (read-only flows like `show`, `list`, `ready`, `prime`,
 *   `stats`, `search`, plus ordinary `create`/`update`/`close --reason`)
 *   passes through untouched.
 *
 * Detection is deliberately conservative: the `command` string is split on
 * shell command separators (`;`, `&&`, `||`, `|`, newlines) and each segment
 * is matched against `bd`/`$BD_BIN`-named invocations (word boundary, optional
 * path prefix, `NAME=VAL` env prefixes skipped). A bare `bd` binary selected
 * via an absolute path still matches.
 *
 * Configuration (environment):
 *  - `BD_BIN`                path/name of the bd binary (default: `bd`)
 *  - `PI_BEADS_GUARD_DISABLE=1`  disable this extension
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLE_ENV = "PI_BEADS_GUARD_DISABLE";
const BD_BIN_ENV = "BD_BIN";

function isDisabled(): boolean {
	const v = process.env[DISABLE_ENV];
	return v === "1" || v?.toLowerCase() === "true";
}

/** Candidate bd binary names: configured BD_BIN plus the default `bd`. */
function bdNames(): string[] {
	const names = new Set(["bd"]);
	const configured = process.env[BD_BIN_ENV];
	if (configured) {
		names.add(configured.split("/").pop() || configured);
	}
	return [...names];
}

/** Split a shell command line into segments on command separators. */
function splitSegments(command: string): string[] {
	return command.split(/(?:^|[;\n])|&&|\|\||\|/g).map((s) => s.trim()).filter(Boolean);
}

/** Tokenize a segment, honouring single/double quotes. */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(segment)) !== null) {
		tokens.push(m[1] ?? m[2] ?? m[3]);
	}
	return tokens;
}

type Verdict =
	| { kind: "allow" }
	| { kind: "block"; reason: string }
	| { kind: "confirm"; title: string; message: string };

/** Classify one shell segment. First non-allow verdict wins per segment. */
function classifySegment(segment: string): Verdict {
	const names = bdNames();
	const tokens = tokenize(segment);
	// Find the bd invocation: first token that names bd (skipping VAR=VAL prefixes).
	let idx = -1;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			continue;
		}
		const base = t.split("/").pop() || t;
		if (names.includes(base)) {
			idx = i;
			break;
		}
		// A leading sudo/env wrapper: look one deeper.
		if ((base === "sudo" || base === "env") && i + 1 < tokens.length) {
			continue;
		}
		break;
	}
	if (idx === -1) {
		return { kind: "allow" };
	}
	const args = tokens.slice(idx + 1);
	const verb = args[0];
	if (!verb || verb.startsWith("-")) {
		return { kind: "allow" };
	}

	if (verb === "edit") {
		return {
			kind: "block",
			reason:
				"bd edit opens $EDITOR and hangs the agent. Use `bd update <id> --title/--description/--notes/--design` flags instead.",
		};
	}
	if (verb === "delete") {
		return {
			kind: "confirm",
			title: "Delete bead(s)?",
			message: `\`${truncate(segment, 120)}\` permanently deletes beads. Allow it?`,
		};
	}
	if (verb === "close") {
		const hasReason = args.some((a) => a === "--reason" || a === "-r" || a.startsWith("--reason="));
		if (!hasReason) {
			return {
				kind: "confirm",
				title: "Close bead(s) without a reason?",
				message: `\`${truncate(segment, 120)}\` has no --reason; the audit trail loses context. Add --reason or confirm anyway?`,
			};
		}
	}
	if ((verb === "update" || verb === "close") && args.includes("--force")) {
		return {
			kind: "confirm",
			title: "Force bead update?",
			message: `\`${truncate(segment, 120)}\` uses --force, overriding another actor's live claim or open blockers. Allow it?`,
		};
	}
	return { kind: "allow" };
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function beadsGuard(pi: ExtensionAPI) {
	if (isDisabled()) {
		return;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") {
			return;
		}
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !command.includes("bd")) {
			return;
		}

		for (const segment of splitSegments(command)) {
			if (!segment.includes("bd")) {
				continue;
			}
			const verdict = classifySegment(segment);
			if (verdict.kind === "allow") {
				continue;
			}
			if (verdict.kind === "block") {
				return { block: true, reason: verdict.reason, terminate: true };
			}
			// confirm: ask in TUI, block headless (safe default).
			if (ctx.hasUI && ctx.mode === "tui") {
				try {
					const ok = await ctx.ui.confirm(verdict.title, verdict.message);
					if (!ok) {
						return { block: true, reason: `Declined: ${verdict.title}`, terminate: true };
					}
					continue;
				} catch {
					return { block: true, reason: `Confirmation unavailable: ${verdict.title}`, terminate: true };
				}
			}
			return {
				block: true,
				reason: `${verdict.title} Non-interactive session: re-run with an explicit reason/flag or confirm in TUI. Matched: \`${truncate(segment, 120)}\``,
				terminate: true,
			};
		}
	});
}
