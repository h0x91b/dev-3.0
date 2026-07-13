/** Gemini CLI adapter. */
import { GENERIC_SKILL_BODY } from "../agent-skill-content";
import { modelArgs } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

/** Gemini uses --approval-mode with its own value set. */
const GEMINI_MODE_MAP: Record<string, string> = {
	acceptEdits: "auto_edit",
	bypassPermissions: "yolo",
	dontAsk: "yolo",
	plan: "plan",
};

export const geminiAdapter: AgentAdapter = {
	command: "gemini",
	supportsResume: true,
	// Launch-time --session-id added in gemini-cli PR #26060; not version-guarded.
	supportsPreAssignedSessionId: true,
	// Gemini has no automatic hooks and no in-command system-prompt channel; it
	// relies on the auto-installed skill file. Kept for the contract only.
	skillBody: GENERIC_SKILL_BODY,
	trustKinds: ["claude", "gemini"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			if (options?.sessionId) args.push("--resume", options.sessionId);
			else args.push("--resume", "latest");
		} else if (options?.sessionId) {
			args.push("--session-id", options.sessionId);
		}

		args.push(...modelArgs(config, options));

		if (config?.permissionMode && config.permissionMode !== "default") {
			args.push("--approval-mode", GEMINI_MODE_MAP[config.permissionMode] ?? config.permissionMode);
		}
		// Gemini ignores dev3's --effort / --max-budget-usd.

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			if (prompt) args.push("--", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --resume ${sessionId}` : `${baseCmd} --resume latest`;
	},

	hooksSpec() {
		return null;
	},
};
