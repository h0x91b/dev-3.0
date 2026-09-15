/** GitHub Copilot CLI adapter (the standalone `copilot` binary, not the older
 *  `gh copilot` extension).
 *
 *  Copilot has no `--append-system-prompt`, and its
 *  `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` only *lists* an AGENTS.md for the model to
 *  open later — verified on 1.0.83, the file's text never reaches the prompt. So
 *  the dev3 protocol travels on the `sessionStart` hook's `additionalContext`
 *  instead (see `dev3 hook copilot`), which lands it in front of fresh, scratch
 *  and resumed sessions alike and keeps it off the command line entirely. */
import { GENERIC_SKILL_BODY } from "../agent-skill-content";
import { modelArgs, providerArgs } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

/** dev3's permission modes in Copilot's own flags. `default` adds nothing.
 *
 *  `acceptEdits` allows the file-writing tools and still asks for shell and
 *  network; `dontAsk` additionally silences `ask_user`, so the agent never stops
 *  to put a question in a pane nobody is watching. */
const COPILOT_MODE_ARGS: Record<string, string[]> = {
	plan: ["--mode", "plan"],
	acceptEdits: ["--allow-tool", "write"],
	auto: ["--allow-all-tools"],
	dontAsk: ["--allow-all-tools", "--no-ask-user"],
	bypassPermissions: ["--allow-all"],
};

export const copilotAdapter: AgentAdapter = {
	command: "copilot",
	supportsResume: true,
	// `--session-id <uuid>` names a fresh session; the id must be a real UUID
	// (a well-formed-looking string with wrong version bits is rejected).
	supportsPreAssignedSessionId: true,
	skillBody: GENERIC_SKILL_BODY,
	trustKinds: ["claude", "copilot"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			if (options?.sessionId) args.push(`--resume=${options.sessionId}`);
			else args.push("--continue");
		} else if (options?.sessionId) {
			args.push("--session-id", options.sessionId);
		}

		args.push(...modelArgs(config, options));
		args.push(...providerArgs(options));

		if (config?.permissionMode && config.permissionMode !== "default") {
			args.push(...(COPILOT_MODE_ARGS[config.permissionMode] ?? []));
		}
		// `auto` picks the model per turn, so it has no reasoning setting to carry:
		// `--model auto --effort xhigh` is refused outright with
		// `Model "auto" does not support reasoning effort configuration`, and the
		// launch never starts. Dropping the flag beats a pane that dies on open.
		if (config?.effort && config.model !== "auto") args.push("--effort", config.effort);
		// Copilot budgets in AI credits, not dollars, so dev3's maxBudgetUsd has no
		// honest mapping here and is deliberately dropped rather than guessed.

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			// `-i` runs the prompt and stays interactive, which is what a dev3 pane
			// is. `-p` would exit the moment the first turn ended.
			const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			if (prompt) args.push("-i", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --resume=${sessionId}` : `${baseCmd} --continue`;
	},

	hooksSpec() {
		return { kind: "copilot" };
	},
};
