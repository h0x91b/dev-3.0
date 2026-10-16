/**
 * The plain pi status extension (earendil-works/pi, `pi`): the module pi loads
 * with `--extension`, reporting the session's lifecycle through `dev3 hook pi`.
 *
 * Same runtime as omp's (`status-extension-core.ts`), different events. Plain
 * pi has no tool-approval tiers, so there is no approval event to map; a
 * blocking prompt raised by one of the user's own extensions (`ui_prompt_*`)
 * is the one wait it can announce. And pi may keep working after `agent_end`
 * (retries, compaction, queued input) — `agent_settled` is upstream's "will not
 * continue on its own" signal, so that is the stop.
 */

import {
	buildStatusExtensionModule,
	statusExtensionHookCli,
	statusExtensionPath,
	writeStatusExtensionFile,
} from "./status-extension-core";

export const PI_STATUS_EXTENSION_BASENAME = "pi-status.ts";

/** Where the extension is written: `<dev3 home>/data/agent-hooks/pi-status.ts`. */
export function piStatusExtensionPath(dev3Home?: string): string {
	return statusExtensionPath(PI_STATUS_EXTENSION_BASENAME, dev3Home);
}

/**
 * | pi event               | reported as                         |
 * |------------------------|-------------------------------------|
 * | `session_start`        | `SessionStart`                      |
 * | `input` (human text)   | `UserPromptSubmit` + prompt         |
 * | `agent_start`          | `UserPromptSubmit`                  |
 * | `tool_execution_start` | `PreToolUse`                        |
 * | `tool_execution_end`   | `PostToolUse`                       |
 * | `ui_prompt_start`      | `PermissionRequest`                 |
 * | `ui_prompt_end`        | `PostToolUse` mid-run, else `Stop`  |
 * | `agent_settled`        | `Stop`                              |
 */
const PI_WIRING = `	// Whether a run is under way, so a prompt answered while pi is idle settles
	// the task again instead of leaving it marked as working.
	let running = false;

	pi.on("session_start", (_event: unknown, ctx: Ctx) => {
		working = false;
		running = false;
		report(ctx, "SessionStart");
	});
	// The submitted text rides on the status report so the human's prompt reaches
	// Agent traffic; an extension-sourced input is the harness talking to itself.
	pi.on("input", (event: { text?: string; source?: string }, ctx: Ctx) => {
		const human = event?.source !== "extension" && typeof event?.text === "string" && event.text.trim();
		reportWorking(ctx, "UserPromptSubmit", human ? { prompt: event.text, submissionId: randomUUID() } : undefined);
	});
	pi.on("agent_start", (_event: unknown, ctx: Ctx) => {
		running = true;
		reportWorking(ctx, "UserPromptSubmit");
	});
	pi.on("tool_execution_start", (_event: unknown, ctx: Ctx) => reportWorking(ctx, "PreToolUse"));
	pi.on("tool_execution_end", (_event: unknown, ctx: Ctx) => reportWorking(ctx, "PostToolUse"));
	pi.on("ui_prompt_start", (_event: unknown, ctx: Ctx) => reportIdle(ctx, "PermissionRequest"));
	pi.on("ui_prompt_end", (_event: unknown, ctx: Ctx) => {
		if (running) reportWorking(ctx, "PostToolUse");
		else reportIdle(ctx, "Stop");
	});
	pi.on("agent_settled", (_event: unknown, ctx: Ctx) => {
		running = false;
		reportIdle(ctx, "Stop");
	});
`;

export function buildPiStatusExtension(options?: { cli?: string }): string {
	return buildStatusExtensionModule({ harness: "pi", cli: options?.cli ?? statusExtensionHookCli(), wiring: PI_WIRING });
}

/** Write the extension for this machine and return its path (atomic, skipped when unchanged). */
export function writePiStatusExtension(options?: { dev3Home?: string; cli?: string }): string {
	return writeStatusExtensionFile(piStatusExtensionPath(options?.dev3Home), buildPiStatusExtension({ cli: options?.cli }));
}
