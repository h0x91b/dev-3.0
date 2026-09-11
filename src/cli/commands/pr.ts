import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ParsedArgs } from "../args";
import { exitError, exitUsage } from "../output";
import { readTaskDirect, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { DEV3_HOME } from "../../bun/paths";
import { buildTaskPrDeepLinkSection, deepLinkSchemeRegistered } from "../../shared/deep-link";
import { CLI_EXIT_CODE_GH_UNAVAILABLE } from "../../shared/cli-exit-codes";

const USAGE = `Usage: dev3 pr create --title "..." [--description "..."] [--base <branch>] [--draft] [--auto-merge[=squash|merge|rebase]]
       dev3 pr auto-merge [<number|url>] [--strategy squash|merge|rebase] [--off]`;

/** Merge strategies `gh pr merge` accepts; `--auto-merge` with no value means squash. */
const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];

export interface PrCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface PrDeps {
	/** Run a binary and capture its output. Tests inject a fake. */
	run(command: string, args: string[], cwd: string): PrCommandResult;
	cwd: string;
	platform: NodeJS.Platform;
	/** `false` when the user turned the PR→task footer off in Settings → Tasks. */
	originTaskLinkEnabled(): boolean;
}

export const realPrDeps: PrDeps = {
	run: (command, args, cwd) => {
		try {
			const res = spawnSync(command, args, { cwd, encoding: "utf-8", timeout: 120_000 });
			return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
		} catch (err) {
			return { status: null, stdout: "", stderr: String(err) };
		}
	},
	cwd: process.cwd(),
	platform: process.platform,
	originTaskLinkEnabled: () => {
		// Read settings.json directly rather than through src/bun/settings.ts: that
		// module pulls the backend's logger and data layer into the CLI's startup
		// graph, and this is one boolean.
		try {
			const file = `${DEV3_HOME}/settings.json`;
			if (!existsSync(file)) return true;
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as { prOriginTaskLink?: unknown };
			return parsed.prOriginTaskLink !== false;
		} catch {
			return true;
		}
	},
};

/**
 * `dev3 pr` — the pull-request verbs that used to be a hand-written `gh` recipe:
 * `create` (push + open, footer included) and `auto-merge` (set or clear it).
 *
 * It is `gh` end to end and deliberately so: `gh` is the only forge client dev3
 * speaks, and an unauthenticated `gh` is refused up front (exit 23) rather than
 * discovered halfway through, after the branch was already pushed.
 */
export async function handlePr(
	subcommand: string | undefined,
	args: ParsedArgs,
	context: CliContext | null,
	deps: PrDeps = realPrDeps,
): Promise<void> {
	if (subcommand === "create") return await createPr(args, context, deps);
	if (subcommand === "auto-merge") return await setAutoMerge(args, context, deps);
	exitUsage(`Unknown subcommand: dev3 pr ${subcommand ?? ""}`.trim() + `\n${USAGE}`);
}

/**
 * `dev3 pr auto-merge` — enable (or with `--off` clear) auto-merge on a pull
 * request that already exists. With no argument `gh` resolves the pull request
 * of the branch checked out here, which is the case that matters: a task that
 * got its approval to merge after the pull request was opened.
 */
async function setAutoMerge(args: ParsedArgs, context: CliContext | null, deps: PrDeps): Promise<void> {
	rejectUnknownFlags(args, ["strategy", "off"]);

	const off = requireValuelessFlag(args, "off");
	if (off && args.flags.strategy !== undefined) {
		exitUsage("--off clears auto-merge, so it takes no --strategy.");
	}
	const strategy = off ? null : (resolveMergeMethod(args.flags.strategy ?? "true", "--strategy") as MergeMethod);
	const target = args.positional[0]?.trim();

	requireAuthenticatedGh(deps);

	const cwd = context?.worktreePath ?? deps.cwd;
	const ghArgs = off ? ["pr", "merge", "--disable-auto"] : ["pr", "merge", "--auto", `--${strategy}`];
	if (target) ghArgs.push(target);

	const res = deps.run("gh", ghArgs, cwd);
	if (res.status !== 0) {
		exitError(
			off ? "gh could not clear auto-merge" : `gh could not enable auto-merge (${strategy})`,
			res.stderr.trim() || res.stdout.trim(),
		);
	}

	const which = target ? ` on ${target}` : "";
	process.stdout.write(off ? `Auto-merge   cleared${which}\n` : `Auto-merge   enabled (${strategy})${which}\n`);
}

async function createPr(args: ParsedArgs, context: CliContext | null, deps: PrDeps): Promise<void> {
	// Deliberately no `--task`: the pull request is opened for the branch checked
	// out HERE, so naming another task would push one branch and describe another.
	rejectUnknownFlags(args, ["title", "description", "base", "draft", "auto-merge"]);

	const title = (args.flags.title ?? "").trim();
	if (!title) exitUsage(`--title is required.\n${USAGE}`);
	const draft = requireValuelessFlag(args, "draft");
	const mergeMethod = resolveMergeMethod(args.flags["auto-merge"]);
	// `--description` with nothing after it parses as the string "true", which would
	// publish a PR body of "true" or silently an empty one. Neither is what was meant.
	if (args.flags.description === "true") {
		exitUsage('--description needs a value: --description "..." , --description @file, or drop the flag.');
	}

	requireAuthenticatedGh(deps);

	const cwd = context?.worktreePath ?? deps.cwd;
	const branch = currentBranch(cwd, deps);
	const base = args.flags.base?.trim() || taskBaseBranch(context);
	if (base && base === branch) {
		exitError(
			`The current branch IS the base branch (${branch}) — there is nothing to open a pull request from.`,
			"Create a branch, commit the work, and run this again.",
		);
	}

	const push = deps.run("git", ["push", "--set-upstream", "origin", branch], cwd);
	if (push.status !== 0) {
		exitError(`git push failed for branch ${branch}`, push.stderr.trim() || push.stdout.trim());
	}

	const ghArgs = ["pr", "create", "--title", title, "--body", prBody(args.flags.description, context, deps)];
	if (base) ghArgs.push("--base", base);
	if (draft) ghArgs.push("--draft");

	const created = deps.run("gh", ghArgs, cwd);
	if (created.status !== 0) {
		exitError("gh pr create failed", created.stderr.trim() || created.stdout.trim());
	}

	const url = prUrl(created.stdout);
	process.stdout.write(`Pushed       ${branch} → origin\n`);
	process.stdout.write(`Pull request ${url || "created (gh printed no URL)"}\n`);
	if (base) process.stdout.write(`Base         ${base}\n`);

	if (!mergeMethod) return;

	// Auto-merge is a second call, so the PR exists either way: a repo with the
	// strategy disabled must not read as "no pull request was opened".
	const mergeTarget = url ? [url] : [];
	const merged = deps.run("gh", ["pr", "merge", "--auto", `--${mergeMethod}`, ...mergeTarget], cwd);
	if (merged.status !== 0) {
		exitError(
			`The pull request was created but auto-merge (${mergeMethod}) could not be enabled`,
			merged.stderr.trim() || merged.stdout.trim(),
		);
	}
	process.stdout.write(`Auto-merge   enabled (${mergeMethod})\n`);
}

/**
 * A switch that takes no value, refused rather than reinterpreted when it got one.
 * `dev3 pr auto-merge --off 1722` parses as `off="1722"` with no positional, which
 * read as "off is not set" and silently did the OPPOSITE — it ENABLED auto-merge on
 * the branch's own pull request. A refusal cannot do that; it names the fix instead.
 */
function requireValuelessFlag(args: ParsedArgs, flag: string): boolean {
	const raw = args.flags[flag];
	if (raw === undefined) return false;
	if (raw === "true") return true;
	exitUsage(
		`--${flag} takes no value (got "${raw}"). A positional argument goes BEFORE the switch, e.g. \`dev3 pr auto-merge ${raw} --${flag}\`.`,
	);
}

/** Flag absent → null; passed with no value → squash; otherwise the named strategy. */
function resolveMergeMethod(raw: string | undefined, flag = "--auto-merge"): MergeMethod | null {
	if (raw === undefined) return null;
	if (raw === "true") return "squash";
	const value = raw.trim().toLowerCase();
	if (!(MERGE_METHODS as readonly string[]).includes(value)) {
		exitUsage(`${flag} takes one of ${MERGE_METHODS.join(", ")} (default squash), got "${raw}".`);
	}
	return value as MergeMethod;
}

/**
 * Refuse before anything is pushed when `gh` is missing or logged out — the one
 * precondition the command has. Exit 23 so a caller can tell "authenticate
 * first" from a pull request that genuinely failed to open.
 */
function requireAuthenticatedGh(deps: PrDeps): void {
	const version = deps.run("gh", ["--version"], deps.cwd);
	if (version.status !== 0) {
		exitError(
			"the GitHub CLI (`gh`) is not available",
			"`dev3 pr create` is gh end to end. Install it (https://cli.github.com) and run `gh auth login`.",
			CLI_EXIT_CODE_GH_UNAVAILABLE,
		);
	}
	const auth = deps.run("gh", ["auth", "status"], deps.cwd);
	if (auth.status !== 0) {
		exitError(
			"`gh` is not authenticated",
			`Run \`gh auth login\` first, then try again.\n${auth.stderr.trim() || auth.stdout.trim()}`,
			CLI_EXIT_CODE_GH_UNAVAILABLE,
		);
	}
}

function currentBranch(cwd: string, deps: PrDeps): string {
	const res = deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (res.status !== 0) {
		exitError("not a git repository (or git failed)", res.stderr.trim() || `cwd: ${cwd}`);
	}
	const branch = res.stdout.trim();
	if (!branch || branch === "HEAD") {
		exitError("HEAD is detached — check out a branch before opening a pull request");
	}
	return branch;
}

/**
 * The base branch the task was created from. dev3 projects whose base is not the
 * repo's default branch would otherwise get a pull request against the wrong
 * base, because that is what `gh` assumes when `--base` is absent.
 */
function taskBaseBranch(context: CliContext | null): string | undefined {
	if (!context) return undefined;
	const task = readTaskDirect(context.projectId, context.taskId);
	const base = task?.baseBranch;
	return typeof base === "string" && base.trim() ? base.trim() : undefined;
}

/**
 * The PR body: the description plus the origin-task footer. The footer is
 * dropped on a host with no `dev3://` handler (the link would be dead in a
 * public pull request), when the user opted out, and outside a task worktree.
 */
function prBody(description: string | undefined, context: CliContext | null, deps: PrDeps): string {
	const body = description?.trim() ?? "";
	if (!context?.taskId) return body;
	if (!deepLinkSchemeRegistered(deps.platform) || !deps.originTaskLinkEnabled()) return body;
	return `${body}${buildTaskPrDeepLinkSection(context.taskId)}`;
}

/** `gh pr create` prints the URL on its own line, sometimes after other chatter. */
function prUrl(stdout: string): string | null {
	const match = stdout.match(/https:\/\/\S*\/pull\/\d+/);
	return match ? match[0] : null;
}
