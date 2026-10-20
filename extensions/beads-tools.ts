/**
 * Beads Tools
 *
 * Typed `bd` operations as pi tools, so the model gets validated calls
 * instead of shelling out to `bd` via bash and scraping text:
 *
 * - `bd_create` — create an issue (title required; type, priority, parent,
 *   description optional).
 * - `bd_update` — update/claim an issue by id (claim, status, assignee,
 *   title, description, notes, append_notes, priority).
 * - `bd_close` — close one or more issues. `reason` is REQUIRED here (the
 *   tool refuses without one), enforcing the audit-trail guardrail that
 *   `beads-guard` asks of raw shell calls.
 * - `bd_ready` — list issues ready to work (no params).
 *
 * Tools are registered on `session_start` when a `.beads/` workspace is
 * found from the session cwd (honoring `BEADS_DIR`); otherwise nothing is
 * registered and no `bd` process is spawned. All commands run with the
 * workspace root as cwd, so per-workspace `bd` configuration applies.
 *
 * Configuration (environment):
 *  - `BD_BIN`                path/name of the bd binary (default: `bd`)
 *  - `PI_BEADS_TOOLS_DISABLE=1`  disable this extension
 *  - `BEADS_DIR`             honored when set to a `.beads` dir or workspace root
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DISABLE_ENV = "PI_BEADS_TOOLS_DISABLE";
const BD_BIN_ENV = "BD_BIN";
const BEADS_DIR_ENV = "BEADS_DIR";
const BD_TIMEOUT_MS = 30_000;

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

type TextResult = {
	content: [{ type: "text"; text: string }];
	isError?: boolean;
	details?: Record<string, unknown>;
};

/** Run bd and wrap the result for tool execute(). */
async function runBd(
	pi: ExtensionAPI,
	ctx: ExtensionToolContext,
	workspace: string,
	args: string[],
): Promise<TextResult> {
	const bd = process.env[BD_BIN_ENV] || "bd";
	let res: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		res = await pi.exec(bd, args, { cwd: workspace, timeout: BD_TIMEOUT_MS });
	} catch (err) {
		return {
			content: [{ type: "text", text: `bd failed to spawn: ${err instanceof Error ? err.message : String(err)}` }],
			isError: true,
		};
	}
	const text = (res.code === 0 ? res.stdout : res.stderr || res.stdout).trim() || "(no output)";
	return {
		content: [{ type: "text", text }],
		isError: res.code !== 0,
		details: { exitCode: res.code },
	};
}

const CREATE_PARAMS = Type.Object({
	title: Type.String({ description: "Issue title/summary" }),
	description: Type.Optional(Type.String({ description: "Why this issue exists and what needs to be done" })),
	type: Type.Optional(
		Type.Union([Type.Literal("task"), Type.Literal("bug"), Type.Literal("feature"), Type.Literal("epic"), Type.Literal("chore")], {
			description: "Issue type",
		}),
	),
	priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4, description: "Priority 0 (critical) to 4 (backlog)" })),
	parent: Type.Optional(Type.String({ description: "Parent issue id for hierarchical children" })),
});

const UPDATE_PARAMS = Type.Object({
	id: Type.String({ description: "Issue id to update" }),
	claim: Type.Optional(Type.Boolean({ description: "Atomically claim the issue (assignee you, status in_progress)" })),
	status: Type.Optional(Type.String({ description: "Status to set (open, in_progress, blocked, closed, deferred)" })),
	assignee: Type.Optional(Type.String({ description: "Assignee username" })),
	title: Type.Optional(Type.String({ description: "New title" })),
	description: Type.Optional(Type.String({ description: "New description" })),
	notes: Type.Optional(Type.String({ description: "Supplementary notes (replaces existing)" })),
	append_notes: Type.Optional(Type.String({ description: "Append to existing notes" })),
	priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4, description: "Priority 0-4" })),
});

const CLOSE_PARAMS = Type.Object({
	ids: Type.Array(Type.String(), { minItems: 1, description: "Issue ids to close" }),
	reason: Type.String({ minLength: 1, description: "Reason for closing (required for the audit trail)" }),
});

const READY_PARAMS = Type.Object({});

export default function beadsTools(pi: ExtensionAPI) {
	if (isDisabled()) {
		return;
	}

	pi.on("session_start", async (_event, ctx) => {
		const workspace = findWorkspaceRoot(ctx.cwd);
		if (!workspace) {
			return;
		}

		pi.registerTool({
			name: "bd_create",
			label: "Beads Create",
			description: "Create a Beads issue in the current workspace. Returns the new issue id.",
			promptSnippet: "bd_create(title, ...): file a Beads issue",
			parameters: CREATE_PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
				const args = ["create", `--title=${params.title}`];
				if (params.description) args.push(`--description=${params.description}`);
				if (params.type) args.push(`--type=${params.type}`);
				if (params.priority !== undefined) args.push(`--priority=${String(params.priority)}`);
				if (params.parent) args.push(`--parent=${params.parent}`);
				return runBd(pi, toolCtx, workspace, args);
			},
		});

		pi.registerTool({
			name: "bd_update",
			label: "Beads Update",
			description: "Update or claim a Beads issue by id. Prefer --claim over manually setting assignee+status.",
			promptSnippet: "bd_update(id, ...): update or claim a Beads issue",
			parameters: UPDATE_PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
				const args = ["update", params.id];
				if (params.claim) args.push("--claim");
				if (params.status) args.push(`--status=${params.status}`);
				if (params.assignee) args.push(`--assignee=${params.assignee}`);
				if (params.title) args.push(`--title=${params.title}`);
				if (params.description) args.push(`--description=${params.description}`);
				if (params.notes) args.push(`--notes=${params.notes}`);
				if (params.append_notes) args.push(`--append-notes=${params.append_notes}`);
				if (params.priority !== undefined) args.push(`--priority=${String(params.priority)}`);
				return runBd(pi, toolCtx, workspace, args);
			},
		});

		pi.registerTool({
			name: "bd_close",
			label: "Beads Close",
			description: "Close one or more Beads issues. A reason is required and recorded in the audit trail.",
			promptSnippet: "bd_close(ids, reason): close Beads issues with a reason",
			parameters: CLOSE_PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
				return runBd(pi, toolCtx, workspace, ["close", ...params.ids, "--reason", params.reason]);
			},
		});

		pi.registerTool({
			name: "bd_ready",
			label: "Beads Ready",
			description: "List Beads issues ready to work (no blockers) in the current workspace.",
			promptSnippet: "bd_ready(): list actionable Beads issues",
			parameters: READY_PARAMS,
			async execute(_toolCallId, _params, _signal, _onUpdate, toolCtx) {
				return runBd(pi, toolCtx, workspace, ["ready"]);
			},
		});
	});
}
