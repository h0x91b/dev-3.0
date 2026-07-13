/** Cursor Agent adapter (base command `agent`). */
import { GENERIC_SKILL_BODY } from "../agent-skill-content";
import { modelArgs } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

export const cursorAdapter: AgentAdapter = {
	command: "agent",
	supportsResume: true,
	// --resume <uuid> creates the thread if missing, so a pre-assigned id works.
	supportsPreAssignedSessionId: true,
	skillBody: GENERIC_SKILL_BODY,
	trustKinds: ["claude"],

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
			if (prompt) prompt = `${prompt}\n\n${GENERIC_SKILL_BODY}`;
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
};
