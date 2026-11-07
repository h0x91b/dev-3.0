/** Plain pi adapter (`pi`, earendil-works/pi — the upstream omp forked from). */
import { PI_SKILL_BODY, PI_LEAN_SKILL_BODY } from "../agent-skill-content";
import { modelArgs, providerArgs, slashExitProgram } from "./common";
import { shellEscape, quoteIfUnsafe } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

export const piAdapter: AgentAdapter = {
	command: "pi",
	supportsResume: true,
	// `--session-id <id>` opens that exact project session, creating it when it is
	// missing — so a fresh launch can pin the id recovery will resume.
	supportsPreAssignedSessionId: true,
	skillBody: PI_SKILL_BODY,
	leanSkillBody: PI_LEAN_SKILL_BODY,
	trustKinds: ["claude"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (options?.sessionId) args.push("--session-id", options.sessionId);
		else if (resume) args.push("-c");

		args.push(...modelArgs(config, options));
		args.push(...providerArgs(options));

		// Plain pi has no approval tiers and no budget flag: it runs every tool
		// without asking, by design, so permissionMode and maxBudgetUsd emit nothing.
		if (config?.effort) args.push("--thinking", config.effort);

		// On resume too: the session file does not keep an appended system prompt,
		// so a resumed session without the flag runs with no dev3 protocol at all.
		if (!options?.skipSystemPrompt) {
			// pi reads the value as a file when it names one, which keeps the body
			// out of argv (h0x91b/dev-3.0#1734) and under the Windows ceiling.
			if (options?.systemPromptFile) {
				args.push("--append-system-prompt", quoteIfUnsafe(options.systemPromptFile));
			} else {
				args.push("--append-system-prompt", shellEscape(options?.protocolBody ?? PI_SKILL_BODY));
			}
		}

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			// After `--`, pi still reads a leading `@` as "attach this file", so a
			// description that opens with a mention would be swallowed as a path.
			if (prompt) args.push("--", shellEscape(prompt.startsWith("@") ? ` ${prompt}` : prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --session-id ${quoteIfUnsafe(sessionId)}` : `${baseCmd} -c`;
	},

	// Status rides on a generated extension module (`src/shared/pi-status-extension.ts`),
	// loaded with `--extension`; the executor returns that flag for the launch to splice in.
	hooksSpec() {
		return { kind: "pi" };
	},

	// `/quit` is pi's own quit command (docs/keybindings.md, built-in slash commands).
	exitProgram() {
		return slashExitProgram("/quit");
	},
};
