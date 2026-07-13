/** OpenCode adapter. */
import { GENERIC_SKILL_BODY } from "../agent-skill-content";
import { modelArgs } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

export const opencodeAdapter: AgentAdapter = {
	command: "opencode",
	supportsResume: true,
	// Resume-only --session; no launch-time pre-assignment.
	supportsPreAssignedSessionId: false,
	skillBody: GENERIC_SKILL_BODY,
	trustKinds: ["claude"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			if (options?.sessionId) args.push("--session", options.sessionId);
			else args.push("--continue");
		}

		args.push(...modelArgs(config, options));
		// OpenCode ignores dev3's --permission-mode / --effort / --max-budget-usd.

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			let prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			if (prompt) prompt = `${prompt}\n\n${GENERIC_SKILL_BODY}`;
			// OpenCode takes the prompt via --prompt (value form is unambiguous, so
			// no `--` separator is needed).
			if (prompt) args.push("--prompt", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --session ${sessionId}` : `${baseCmd} --continue`;
	},

	hooksSpec() {
		return null;
	},
};
