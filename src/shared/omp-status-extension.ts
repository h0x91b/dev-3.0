/**
 * The omp status extension: a TypeScript module omp loads with `--hook`, which
 * reports the session's lifecycle to the board through `dev3 hook omp`.
 *
 * omp has no Claude/Codex-style JSON hooks. Its extension API runs in-process
 * and hands every event to a handler, so the module below is the whole bridge:
 * it maps omp's events onto the status-hook vocabulary Codex already speaks
 * (`AGENT_STATUS_HOOK_EVENTS`) and spawns one dev3 CLI process per report, exactly
 * like a Codex hook command. The body is generated here (pure) and written by
 * `writeOmpStatusExtension` (I/O), mirroring the build/write split of the
 * Claude and Codex hooks.
 *
 * The file lives under the dev3 home rather than in each worktree, for the same
 * reason the Codex declarations live in `~/.codex/config.toml`: it is one
 * generated artifact, rewritten before every launch, referenced by absolute path.
 * The runtime itself is shared with plain pi (`status-extension-core.ts`).
 */

import type { Dev3CliLookup } from "./dev3-cli-path";
import {
	buildStatusExtensionModule,
	statusExtensionHookCli,
	statusExtensionPath,
	writeStatusExtensionFile,
} from "./status-extension-core";

export const OMP_STATUS_EXTENSION_BASENAME = "omp-status.ts";
export const OMP_HOOK_SUBCOMMAND = "hook omp";

/** Where the extension is written: `<dev3 home>/data/agent-hooks/omp-status.ts`. */
export function ompStatusExtensionPath(dev3Home?: string): string {
	return statusExtensionPath(OMP_STATUS_EXTENSION_BASENAME, dev3Home);
}

/** The dev3 CLI path baked into the module (see `statusExtensionHookCli`). */
export function ompStatusHookCli(lookup: Dev3CliLookup = {}): string {
	return statusExtensionHookCli(lookup);
}

/**
 * omp's event wiring, into the Codex vocabulary the socket handler expects:
 *
 * | omp event                 | reported as        |
 * |---------------------------|--------------------|
 * | `session_start`           | `SessionStart`     |
 * | `input` (human text)      | `UserPromptSubmit` + prompt |
 * | `agent_start`             | `UserPromptSubmit` |
 * | `tool_execution_start`    | `PreToolUse`       |
 * | `tool_execution_end`      | `PostToolUse`      |
 * | `tool_approval_requested` | `PermissionRequest`|
 * | `tool_approval_resolved`  | `PostToolUse`      |
 * | `agent_end`               | `Stop`             |
 */
const OMP_WIRING = `	// A session belongs to the agent whose runner loaded this module; an approval
	// raised for another session in the same process is not this task's.
	const ownSession = (event: { sessionId?: string } | undefined, ctx: Ctx | undefined): boolean => {
		const own = sessionIdOf(ctx);
		return !event?.sessionId || !own || event.sessionId === own;
	};

	pi.on("session_start", (_event: unknown, ctx: Ctx) => {
		working = false;
		report(ctx, "SessionStart");
	});
	// The submitted text rides on the status report so the human's prompt reaches
	// Agent traffic; an extension-sourced input is the harness talking to itself.
	pi.on("input", (event: { text?: string; source?: string }, ctx: Ctx) => {
		const human = event?.source !== "extension" && typeof event?.text === "string" && event.text.trim();
		reportWorking(ctx, "UserPromptSubmit", human ? { prompt: event.text, submissionId: randomUUID() } : undefined);
	});
	pi.on("agent_start", (_event: unknown, ctx: Ctx) => reportWorking(ctx, "UserPromptSubmit"));
	pi.on("tool_execution_start", (_event: unknown, ctx: Ctx) => reportWorking(ctx, "PreToolUse"));
	pi.on("tool_execution_end", (_event: unknown, ctx: Ctx) => reportWorking(ctx, "PostToolUse"));
	pi.on("tool_approval_requested", (event: { sessionId?: string }, ctx: Ctx) => {
		if (ownSession(event, ctx)) reportIdle(ctx, "PermissionRequest");
	});
	pi.on("tool_approval_resolved", (event: { sessionId?: string }, ctx: Ctx) => {
		if (ownSession(event, ctx)) reportWorking(ctx, "PostToolUse");
	});
	// An agent_end that omp will follow with its own retry is not a settle.
	pi.on("agent_end", (event: { willContinue?: boolean }, ctx: Ctx) => {
		if (event?.willContinue) return;
		reportIdle(ctx, "Stop");
	});
`;

export function buildOmpStatusExtension(options?: { cli?: string }): string {
	return buildStatusExtensionModule({ harness: "omp", cli: options?.cli ?? ompStatusHookCli(), wiring: OMP_WIRING });
}

/** Write the extension for this machine and return its path (atomic, skipped when unchanged). */
export function writeOmpStatusExtension(options?: { dev3Home?: string; cli?: string }): string {
	return writeStatusExtensionFile(ompStatusExtensionPath(options?.dev3Home), buildOmpStatusExtension({ cli: options?.cli }));
}
