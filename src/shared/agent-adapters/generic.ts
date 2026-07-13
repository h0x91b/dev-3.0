/** Generic fallback adapter for unknown / custom base commands.
 *
 * Encodes today's fall-through EXACTLY: it emits the Claude-shaped generic flags
 * (--model, --permission-mode verbatim, --effort, --max-budget-usd) and a
 * positional `-- <prompt>`, but injects NO skill body (only Cursor/OpenCode do,
 * and those have full adapters), installs NO hooks, and does not resume or
 * pre-assign a session. Claude trust is still applied (the pre-refactor code
 * applied it to every agent). Byte-identical output is guarded by the Seam A
 * golden test — do not "clean this up" into body injection. */
import { GENERIC_SKILL_BODY } from "../agent-skill-content";
import { modelArgs } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

export const genericAdapter: AgentAdapter = {
	command: "",
	supportsResume: false,
	supportsPreAssignedSessionId: false,
	// Never injected by launchArgs — held only so the descriptor is complete.
	skillBody: GENERIC_SKILL_BODY,
	trustKinds: ["claude"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];

		args.push(...modelArgs(config, options));

		if (config?.permissionMode && config.permissionMode !== "default") {
			args.push("--permission-mode", config.permissionMode);
		}
		if (config?.effort) args.push("--effort", config.effort);
		if (config?.maxBudgetUsd != null && config.maxBudgetUsd > 0) {
			args.push("--max-budget-usd", String(config.maxBudgetUsd));
		}

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
		if (prompt) args.push("--", shellEscape(prompt));

		return [baseCmd, ...args];
	},

	buildResumeCommand() {
		return null;
	},

	hooksSpec() {
		return null;
	},
};
