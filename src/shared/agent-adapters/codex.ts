/** Codex adapter. Owns Codex's quirks: the `resume` subcommand, the theme
 *  profile rewrite, and the developer-instructions delivery channel. */
import { CODEX_SKILL_BODY } from "../agent-skill-content";
import { modelArgs } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter, CodexLaunchRuntime } from "./types";

/**
 * Rewrite a `dev3` profile to the themed profile (and, on the transition-window
 * codex, `-p`/`--profile` → `--profile-v2`), then append the per-launch
 * `tui.theme` override. Mutates `args` in place. No-op if the codex runtime is
 * absent (the backend always supplies it for a real launch). See decision 055 /
 * issue #611.
 */
function applyCodexTheme(args: string[], codex: CodexLaunchRuntime | undefined): void {
	if (!codex) return;
	for (let i = 0; i < args.length - 1; i++) {
		if ((args[i] === "-p" || args[i] === "--profile") && args[i + 1] === "dev3") {
			args[i + 1] = codex.themedProfile;
			if (codex.profileLaunchFlag === "--profile-v2") args[i] = "--profile-v2";
			break;
		}
	}
	// Codex rejected tui.theme inside config profiles, so select it per-launch.
	args.push("-c", shellEscape(`tui.theme="${codex.theme}"`));
}

export const codexAdapter: AgentAdapter = {
	command: "codex",
	supportsResume: true,
	// Codex has no launch-time session flag; its real id is captured post-hoc
	// from the lifecycle hook.
	supportsPreAssignedSessionId: false,
	skillBody: CODEX_SKILL_BODY,
	trustKinds: ["claude", "codex"],

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		// Resume uses a subcommand (assembled at the end). Codex ignores dev3's
		// generic permission-mode / effort / budget flags.
		args.push(...modelArgs(config, options));
		if (config?.additionalArgs) args.push(...config.additionalArgs);

		applyCodexTheme(args, options?.codex);

		// No --append-system-prompt; deliver the dev3 protocol as a developer-role
		// message via `-c developer_instructions=...` (additive, covers scratch and
		// resumed sessions, keeps the turn-1 user message clean). JSON.stringify
		// emits a valid TOML basic string.
		if (!options?.skipSystemPrompt) {
			args.push("-c", shellEscape(`developer_instructions=${JSON.stringify(CODEX_SKILL_BODY)}`));
		}

		if (!resume) {
			const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			if (prompt) args.push("--", shellEscape(prompt));
		}

		// `codex resume [--last | <id>] [args]`
		if (resume) {
			return [baseCmd, "resume", options?.sessionId ?? "--last", ...args];
		}
		return [baseCmd, ...args];
	},

	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} resume ${sessionId}` : `${baseCmd} resume --last`;
	},

	hooksSpec() {
		return { kind: "codex" };
	},
};
