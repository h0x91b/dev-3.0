/** Oh My Pi adapter (`omp`, can1357/oh-my-pi — a fork of pi). */
import { GENERIC_SKILL_BODY } from "../agent-skill-content";
import { modelArgs, providerArgs } from "./common";
import { hasOmpFlag, OMP_APPROVAL_MODE } from "./omp-flags";
import { shellEscape, quoteIfUnsafe } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter } from "./types";

export const ompAdapter: AgentAdapter = {
	command: "omp",
	supportsResume: true,
	// `--resume [id]` resolves an existing session id prefix or path.
	supportsPreAssignedSessionId: false,
	skillBody: GENERIC_SKILL_BODY,
	trustKinds: ["claude"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			if (options?.sessionId) args.push("--resume", options.sessionId);
			else args.push("-c");
		}

		args.push(...modelArgs(config, options));
		args.push(...providerArgs(options));

		// Always explicit, `default` included: with no flag omp runs at its own
		// configured tier, `yolo` out of the box. A preset that names the flag in
		// additionalArgs is the user's word and wins, so it is not doubled.
		if (!hasOmpFlag(config?.additionalArgs, "--approval-mode")) {
			args.push("--approval-mode", OMP_APPROVAL_MODE[config?.permissionMode ?? "default"]);
		}
		if (config?.effort && !hasOmpFlag(config?.additionalArgs, "--thinking")) {
			args.push("--thinking", config.effort);
		}

		if (!resume && !options?.skipSystemPrompt) {
			// One flag, either form: omp reads the value as a file when it names one.
			// Keeping the body out of argv matters beyond the Windows ceiling — an
			// inline copy is what `pkill -f` matches against (h0x91b/dev-3.0#1734).
			if (options?.systemPromptFile) {
				args.push("--append-system-prompt", quoteIfUnsafe(options.systemPromptFile));
			} else {
				args.push("--append-system-prompt", shellEscape(GENERIC_SKILL_BODY));
			}
		}

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			if (prompt) args.push("--", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --resume ${sessionId}` : `${baseCmd} -c`;
	},

	hooksSpec() {
		return null;
	},
};
