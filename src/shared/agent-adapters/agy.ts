/** Antigravity CLI adapter (`agy`).
 *
 *  agy has no system-prompt flag and its `--settings` carries only settings.json
 *  keys, so the dev3 protocol travels on the `SessionStart` hook's `systemMessage`
 *  (see `dev3 hook agy`) from hooks dev3 writes into the worktree's `.agents/`.
 *  A launcher may override HOME, so nothing dev3 needs lives under `~/.gemini`. */
import { DEV3_AUTO_APPROVED_SUBCOMMANDS, agyHookDialect, agyStatusLineCommand } from "../agent-hooks";
import { AGY_SKILL_BODY } from "../agent-skill-content";
import { modelArgs, providerArgs, slashExitProgram } from "./common";
import { shellEscape } from "./shell";
import { buildTaskPrompt } from "./template";
import type { AgentAdapter, AgyLaunchRuntime } from "./types";

/** dev3's permission modes in agy's own flags. `default` adds nothing. */
const AGY_MODE_ARGS: Record<string, string[]> = {
	acceptEdits: ["--mode", "accept-edits"],
	plan: ["--mode", "plan"],
	auto: ["--mode", "auto"],
	dontAsk: ["--dangerously-skip-permissions"],
	bypassPermissions: ["--dangerously-skip-permissions"],
};

/** agy bakes reasoning effort into the model slug (`gemini-4-neon-high`). */
const AGY_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/** Fold a slug to its model family, so a preset and the account's list compare on identity, not effort tier. */
function agyModelBase(slug: string): string {
	return slug.replace(AGY_EFFORT_SUFFIX, "");
}

const AGY_SLUG = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * `agy models` prints one model per line: `<slug><spaces><display name>`. The first
 * token of each line that looks like a slug is the model; null when none does, so an
 * unreadable output filters nothing.
 */
function parseAgyModels(stdout: string): string[] | null {
	// eslint-disable-next-line no-control-regex
	const text = stdout.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
	const slugs: string[] = [];
	for (const line of text.split("\n")) {
		const token = line.trim().split(/\s+/)[0] ?? "";
		if (AGY_SLUG.test(token)) slugs.push(token);
	}
	return slugs.length > 0 ? slugs : null;
}

/**
 * One rule per auto-approved dev3 subcommand and per spelling of the CLI the agent may type
 * (bare, `~`, the account home expanded). agy matches word by word, so `dev3 note add` covers
 * `dev3 note add "text"`, but not a different spelling of `dev3`.
 */
function agyAllowRules(accountHome?: string): string[] {
	const home = accountHome?.replace(/\/+$/, "");
	const spellings = ["dev3", "~/.dev3.0/bin/dev3", ...(home && !/\s/.test(home) ? [`${home}/.dev3.0/bin/dev3`] : [])];
	return spellings.flatMap((cli) => DEV3_AUTO_APPROVED_SUBCOMMANDS.map((sub) => `command(${cli} ${sub})`));
}

/**
 * The per-session `--settings` payload (agy never saves it to disk):
 * - a trusted workspace suppresses the folder trust dialog, but only by its REALPATH;
 * - `permissions.allow` lets the dev3 metadata subcommands run unprompted;
 * - the statusLine reports quota and permission waits, stacked under agy's own line.
 */
export function agySessionSettings(worktreePath: string, runtime?: AgyLaunchRuntime): string {
	const trusted = runtime?.worktreeRealPath || worktreePath;
	return JSON.stringify({
		...(trusted ? { trustedWorkspaces: [trusted] } : {}),
		permissions: { allow: agyAllowRules(runtime?.accountHome) },
		statusLine: {
			command: agyStatusLineCommand({
				trackLimits: runtime?.trackRateLimits !== false,
				...(runtime?.accountHome ? { dialect: agyHookDialect(runtime.accountHome) } : {}),
			}),
			stack_with_default: true,
		},
	});
}

export const agyAdapter: AgentAdapter = {
	command: "agy",
	supportsResume: true,
	// agy has no flag to name a conversation up front; its id is captured from the hook.
	supportsPreAssignedSessionId: false,
	// No `skillFamily`: the body is not injected at launch. The SessionStart hook
	// renders it (`skillBodyFor("agy")`) and a gitless task, whose folder dev3 does
	// not own, gets no hooks — there the launch prompt carries the shared-folder notice.
	skillBody: AGY_SKILL_BODY,
	trustKinds: ["claude"],
	// Effort is part of the slug, so compare on the model family (see agyModelBase).
	modelListProbe: {
		args: ["models"],
		timeoutMs: 5000,
		parse: parseAgyModels,
		normalize: agyModelBase,
	},

	launchArgs(baseCmd, config, ctx, options) {
		const args: string[] = [];
		const resume = options?.resume ?? false;

		if (resume) {
			if (options?.sessionId) args.push("--conversation", options.sessionId);
			else args.push("--continue");
		}

		args.push(...modelArgs(config, options));
		if (config?.effort) args.push("--effort", config.effort);
		if (config?.permissionMode) args.push(...(AGY_MODE_ARGS[config.permissionMode] ?? []));
		args.push(...providerArgs(options));
		args.push("--settings", shellEscape(agySessionSettings(ctx.worktreePath, options?.agy)));
		// agy has no budget flag, so dev3's maxBudgetUsd is dropped.

		if (config?.additionalArgs) args.push(...config.additionalArgs);

		if (!resume) {
			// `-i` runs the prompt and stays interactive, which is what a dev3 pane is.
			const prompt = buildTaskPrompt(config?.appendPrompt, ctx);
			if (prompt) args.push("-i", shellEscape(prompt));
		}

		return [baseCmd, ...args];
	},

	// Without the worktree path there is no `--settings` here; the conversation itself resumes.
	buildResumeCommand(baseCmd, sessionId) {
		return sessionId ? `${baseCmd} --conversation ${sessionId}` : `${baseCmd} --continue`;
	},

	// The statusLine reports a permission wait (`tool_confirmation_pending`), so a BEL adds nothing:
	// agy rings one at every turn end too, and acting on it fought the Stop hook.
	hooksReportPermissionWaits: true,

	hooksSpec() {
		return { kind: "agy" };
	},

	exitProgram() {
		return slashExitProgram("/quit");
	},
};
