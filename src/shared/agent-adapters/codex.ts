/** Codex adapter. Owns Codex's quirks: the `resume` subcommand, the theme
 *  profile rewrite, and the developer-instructions delivery channel. */
import { CODEX_SKILL_BODY } from "../agent-skill-content";
import { modelArgs, providerArgs } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter, CodexLaunchRuntime } from "./types";

/** An arg's flag name, with any `=value` payload stripped. Codex accepts both
 *  `--profile x` and `--profile=x`, so matching only the spaced form would let
 *  dev3 override a choice the user did make. */
function flagName(arg: string): string {
	const eq = arg.indexOf("=");
	return eq === -1 ? arg : arg.slice(0, eq);
}

function selectsProfile(arg: string): boolean {
	const name = flagName(arg);
	return name === "-p" || name === "--profile" || name === "--profile-v2";
}

/**
 * Rewrite a `dev3` profile to the themed profile (and, on the transition-window
 * codex, `-p`/`--profile` → `--profile-v2`), then append the per-launch
 * `tui.theme` override, adding our own profile when the preset named none.
 * Mutates `args` in place. No-op if the codex runtime is absent (the backend
 * always supplies it for a real launch). See decision 055 / issue #611.
 */
function applyCodexTheme(args: string[], codex: CodexLaunchRuntime | undefined): void {
	if (!codex) return;
	let rewrote = false;
	for (let i = 0; i < args.length; i++) {
		const name = flagName(args[i]);
		if (name !== "-p" && name !== "--profile") continue;
		const inline = args[i].length > name.length;
		if ((inline ? args[i].slice(name.length + 1) : args[i + 1]) !== "dev3") continue;
		const flag = codex.profileLaunchFlag === "--profile-v2" ? "--profile-v2" : name;
		if (inline) args[i] = `${flag}=${codex.themedProfile}`;
		else {
			args[i] = flag;
			args[i + 1] = codex.themedProfile;
		}
		rewrote = true;
		break;
	}
	// The dev3 profile carries more than the theme: it is where the hook trust
	// hashes live, so a preset that names no profile gets ours rather than
	// silently running with untrusted hooks. A profile the user chose is left be.
	if (!rewrote && !args.some(selectsProfile)) {
		args.push(codex.profileLaunchFlag, codex.themedProfile);
	}
	// Codex rejected tui.theme inside config profiles, so select it per-launch.
	args.push("-c", shellEscape(`tui.theme="${codex.theme}"`));
}

/** The permissions preset dev3 writes into the user's Codex config; it is what
 *  opens `~/.dev3.0` and the skill dirs. Codex's own default (`workspace`) does
 *  not, so an agent launched without it cannot reach the dev3 CLI at all. */
const DEV3_PERMISSIONS = 'default_permissions="dev3"';

/** Flags that already decide permissions — leave a launch that carries one of
 *  them alone, including a deliberately sandboxed or fully bypassed run.
 *
 *  `--full-auto` counts because it is shorthand for a sandbox choice. Approval
 *  flags (`-a` / `--ask-for-approval`) deliberately do not: they decide when
 *  Codex stops to ask, not what the process may touch, so a launch carrying one
 *  still gets the dev3 preset and keeps its access to `~/.dev3.0`. */
function decidesPermissions(arg: string): boolean {
	const name = flagName(arg);
	return (
		name === "-s" ||
		name === "--sandbox" ||
		name === "--full-auto" ||
		name === "--dangerously-bypass-approvals-and-sandbox" ||
		arg.includes("default_permissions") ||
		arg.includes("sandbox_mode") ||
		arg.includes("sandbox_permissions")
	);
}

/**
 * Give the launch the dev3 permissions preset when nothing else in it decides
 * permissions. Reaching `~/.dev3.0` is infrastructure, not a preference: without
 * it `dev3 current` fails with EPERM, hooks never fire and the task's status
 * never moves — the agent looks alive and is deaf. A preset built by hand (the
 * `+ New preset` button seeds an empty one) carries no flags at all, which is
 * exactly how a working-looking Codex session ends up unable to talk to dev3.
 */
function applyDev3Permissions(args: string[]): void {
	if (args.some(decidesPermissions)) return;
	args.push("-c", shellEscape(DEV3_PERMISSIONS));
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
		// Backend routing (e.g. Bedrock's `-c model_provider=...`) before the
		// config's additionalArgs, so an explicit user override still wins —
		// relies on codex's repeated-`-c` last-wins semantics (decision 163).
		args.push(...providerArgs(options));
		if (config?.additionalArgs) args.push(...config.additionalArgs);

		applyDev3Permissions(args);
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
