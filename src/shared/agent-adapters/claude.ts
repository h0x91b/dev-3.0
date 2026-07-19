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
		// Always make the dangerous bypass mode *available* to toggle into
		// (Shift+Tab) without enabling it by default — the switch capability
		// belongs on every claude session regardless of the preset. Skip when a
		// bypass flag is already present (either the hard --dangerously-skip-
		// permissions used by Bypass/Default/Accept-Edits presets, or this same
		// --allow- flag) so we never emit a duplicate. This is the single source
		// for the allow flag; presets should not carry it explicitly.
		const hasBypassFlag = config?.additionalArgs?.some(
			(a) => a === "--dangerously-skip-permissions" || a === "--allow-dangerously-skip-permissions",
		);
		if (!hasBypassFlag) args.push("--allow-dangerously-skip-permissions");
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
