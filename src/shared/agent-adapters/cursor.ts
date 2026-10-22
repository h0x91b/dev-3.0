/** Cursor Agent adapter (base command `agent`). */
import { GENERIC_SKILL_BODY, GENERIC_LEAN_SKILL_BODY } from "../agent-skill-content";
import { modelArgs, providerArgs, slashExitProgram } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

/** Trailing slug segments Cursor uses for reasoning effort / speed, not model
 *  identity. Stripped so `gpt-5.6-sol-xhigh` (a preset) and `gpt-5.6-sol-high`
 *  (what `--list-models` happens to enumerate) both fold to `gpt-5.6-sol`. */
const CURSOR_EFFORT_SUFFIXES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "fast", "thinking"]);

/** Fold a Cursor slug to its base model family by dropping trailing effort/speed
 *  tokens. Errs toward availability: matching the base means the account has the
 *  model, even if the exact effort tier is not the one `--list-models` printed. */
function cursorModelBase(slug: string): string {
	const parts = slug.split("-");
	while (parts.length > 1 && CURSOR_EFFORT_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
	return parts.join("-");
}

/** Drop ANSI CSI escapes (cursor's `--list-models` emits `\e[2K\e[G` and colour
 *  codes on stdout even when piped), so the parser sees clean text. */
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * `cursor-agent --list-models` prints one model per line as `slug - Display Name`
 * under an "Available models" header (no dash). Pull the leading slug from every
 * such row, after stripping ANSI escapes. Empty result is treated as unknown
 * upstream, so a format change or a trust prompt filters nothing rather than
 * wiping the picker.
 */
function parseCursorModels(stdout: string): string[] | null {
	const slugs: string[] = [];
	for (const line of stripAnsi(stdout).split("\n")) {
		const match = line.match(/^\s*(\S+)\s+-\s+\S/);
		if (match) slugs.push(match[1]);
	}
	return slugs;
}

export const cursorAdapter: AgentAdapter = {
	command: "agent",
	supportsResume: true,
	// --resume <uuid> creates the thread if missing, so a pre-assigned id works.
	supportsPreAssignedSessionId: true,
	skillBody: GENERIC_SKILL_BODY,
	leanSkillBody: GENERIC_LEAN_SKILL_BODY,
	trustKinds: ["claude"],
	// Cursor bakes effort into the slug and `--list-models` lists only some tiers,
	// so compare on the base family (see cursorModelBase) rather than exact slug.
	modelListProbe: {
		args: ["--list-models"],
		timeoutMs: 5000,
		parse: parseCursorModels,
		normalize: cursorModelBase,
	},

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			if (options?.sessionId) args.push("--resume", options.sessionId);
			else args.push("--continue");
		} else if (options?.sessionId) {
			// Pre-assign via --resume <id> (creates a new thread).
			args.push("--resume", options.sessionId);
		}

		args.push(...modelArgs(config, options));
		args.push(...providerArgs(options));

		if (config?.permissionMode && config.permissionMode !== "default") {
			if (config.permissionMode === "plan") args.push("--mode", "plan");
			else if (config.permissionMode === "bypassPermissions") args.push("--force");
			// "acceptEdits" and "dontAsk" have no cursor equivalent — skip.
		}

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			let prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			// Cursor has no out-of-band system-prompt channel and no automatic
			// hooks, so inject the generic dev3 protocol via the prompt — but only
			// when there is an actual task prompt (empty/scratch launches open an
			// interactive window instead).
			if (prompt) prompt = `${prompt}\n\n${options?.protocolBody ?? GENERIC_SKILL_BODY}`;
			if (prompt) args.push("--", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --resume ${sessionId}` : `${baseCmd} --continue`;
	},

	hooksSpec() {
		return null;
	},

	exitProgram() {
		return slashExitProgram("/exit");
	},
};
