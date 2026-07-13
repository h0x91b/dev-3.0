/** Claude Code adapter. */
import { CLAUDE_SKILL_BODY } from "../agent-skill-content";
import { modelArgs } from "./common";
import { shellEscape, quoteIfUnsafe } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

export const claudeAdapter: AgentAdapter = {
	command: "claude",
	supportsResume: true,
	supportsPreAssignedSessionId: true,
	skillBody: CLAUDE_SKILL_BODY,
	trustKinds: ["claude"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			// Prefer --resume <id> for targeted resume; fall back to --continue.
			if (options?.sessionId) args.push("--resume", options.sessionId);
			else args.push("--continue");
		} else if (options?.sessionId) {
			// Fresh launch with a pre-assigned session id for later targeted resume.
			args.push("--session-id", options.sessionId);
		}

		args.push(...modelArgs(config, options));

		if (config?.permissionMode && config.permissionMode !== "default") {
			args.push("--permission-mode", config.permissionMode);
		}
		if (config?.effort) args.push("--effort", config.effort);
		if (config?.maxBudgetUsd != null && config.maxBudgetUsd > 0) {
			args.push("--max-budget-usd", String(config.maxBudgetUsd));
		}

		if (!options?.skipSystemPrompt) {
			args.push("--append-system-prompt", shellEscape(CLAUDE_SKILL_BODY));
		}

		// Route statusLine through `dev3 statusline` (rate-limit capture), unless
		// the user passes their own --settings via additionalArgs.
		if (
			options?.statuslineSettingsFile &&
			!config?.additionalArgs?.some((a) => a === "--settings" || a.startsWith("--settings="))
		) {
			args.push("--settings", quoteIfUnsafe(options.statuslineSettingsFile));
		}

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			// `--` terminates option parsing so prompts starting with "---" are not
			// treated as unknown flags.
			if (prompt) args.push("--", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --resume ${sessionId}` : `${baseCmd} --continue`;
	},

	hooksSpec(options) {
		return { kind: "claude", stopTarget: options?.stopTarget, permissionMode: options?.permissionMode };
	},
};
