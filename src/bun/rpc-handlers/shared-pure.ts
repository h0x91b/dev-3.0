/**
 * Pure helper functions with no electrobun or bun:ffi dependencies.
 * Split from shared.ts so that modules like tmux-pty.ts can be imported
 * in standalone bun scripts (e.g. e2e tests) without triggering native deps.
 */
import type { Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, DEV3_REPO_CONFIG_KEYS } from "../../shared/types";
import {
	assertPosixLaunchDialect,
	getLaunchShellPath,
	indentLines,
	launchDialect,
	posixEscapeForDoubleQuotes,
} from "../../shared/platform-launch";
import { createLogger } from "../logger";
import { DEV3_HOME } from "../paths";
import { broadcastToOtherInstances } from "../instance-broadcast";
import { realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { whichSync } from "../which";
import { isExecutableFile } from "../executable";

export const log = createLogger("rpc");

/**
 * POSIX-only escaping used where a command line is embedded in a tmux
 * double-quoted argument. tmux itself is POSIX-only, so this has no Windows
 * counterpart in the dialect.
 */
export function escapeForDoubleQuotes(s: string): string {
	return posixEscapeForDoubleQuotes(s);
}

/** Quote a literal for the current platform's script dialect. */
export function shellQuote(s: string): string {
	return launchDialect().quote(s);
}

/** The shell that interprets dev3's generated wrapper scripts. */
export function getScriptShellPath(shellPath?: string): string {
	return getLaunchShellPath(shellPath);
}

export function buildScriptRunnerCommand(
	scriptPath: string,
	options?: { shellPath?: string; trace?: boolean },
): string {
	return launchDialect().runScript(scriptPath, options);
}

export function buildEnvExports(env: Record<string, string>): string[] {
	// ENV_UNSET marks a variable for active removal (agent account switcher):
	// the launched shell inherits the long-lived tmux server env, so a stale
	// value must be actively removed, not merely left out of the exports.
	return launchDialect().envLines(env);
}

/** Read a single keypress silently, in the current dialect. */
export function portableReadKey(options?: { timeoutSeconds?: number }): string {
	return launchDialect().readKey(options);
}

/**
 * Write a generated wrapper script. The ONLY way dev3 puts one on disk: the
 * dialect decides whether the file needs a byte-order mark, and a `.ps1` without
 * one is read as ANSI by Windows PowerShell 5.1 (see `scriptByteOrderMark`).
 */
export async function writeLaunchScript(scriptPath: string, body: string): Promise<void> {
	await Bun.write(scriptPath, launchDialect().scriptByteOrderMark + body);
}

export function buildCmdScript(
	tmuxCmd: string,
	env?: Record<string, string>,
	options?: { paneTitle?: string; keepShell?: boolean; onExitCommand?: string; shellPath?: string },
): string {
	const d = launchDialect();
	const exportLines = env && Object.keys(env).length > 0 ? d.envLines(env) : [];
	const safePaneTitle = options?.paneTitle?.replace(/'/g, "") ?? "";
	const titleLine = safePaneTitle ? d.paneTitle(safePaneTitle) : "";
	const onExitLines = options?.onExitCommand ? [options.onExitCommand] : [];
	const handOverToShell = d.execReplacing(d.interactiveShellCommand(options?.shellPath));
	const failNotice = d.print(d.style("✗ Process exited with code %s", "error"), {
		blankBefore: true,
		args: [d.exitCodeArg("__EC")],
	});
	const preamble = [
		...d.header(),
		...(titleLine ? [titleLine] : []),
		...exportLines,
		...d.announceAndRun(`Starting: ${tmuxCmd}`, tmuxCmd),
		d.captureExitCode("__EC"),
	];
	if (options?.keepShell) {
		const okNotice = d.print(
			d.style("Agent session ended (exit 0). You are in the worktree shell.", "dim"),
			{ blankBefore: true },
		);
		return [
			...preamble,
			...d.branchOnFailure("__EC", {
				fail: indentLines(2, [failNotice]),
				ok: [...indentLines(2, [okNotice]), ...onExitLines],
			}),
			handOverToShell,
			"",
		].join("\n");
	}
	return [
		...preamble,
		...d.branchOnFailure("__EC", {
			fail: indentLines(2, [failNotice, handOverToShell]),
			ok: onExitLines,
		}),
		"",
	].join("\n");
}

/**
 * Wrapper used when the agent binary is missing: it prints install guidance and
 * re-checks PATH on every keypress, handing the view over to the real agent
 * wrapper as soon as the binary appears.
 */
export function buildAgentRetryWrapper(opts: {
	binaryName: string;
	installCmd: string;
	originalCmdPath: string;
	shellPath: string;
}): string {
	const d = launchDialect();
	const binary = d.quote(opts.binaryName);
	const check = d.declareFunction(
		"check_and_run",
		indentLines(
			2,
			d.ifCommandExists(
				opts.binaryName,
				indentLines(2, [
					d.print(d.style("✓ Found %s", "success"), { blankBefore: true, blankAfter: true, args: [binary] }),
					d.execReplacing(d.runScript(opts.originalCmdPath, { shellPath: opts.shellPath })),
				]),
			),
		),
	);
	const loop = d.loopForever(
		indentLines(2, [
			d.print(d.style("✗ Agent not found: %s", "error"), { blankAfter: true, args: [binary] }),
			d.print(`${d.style("Install:", "bold")} %s`, { args: [d.quote(opts.installCmd)] }),
			d.print(d.style('After installing, run "%s" once in a terminal to log in.', "dim"), { args: [binary] }),
			d.print(d.style("Installation and setup are not managed by dev-3.0.", "dim"), { blankAfter: true }),
			d.print(`Press ${d.style("Enter", "bold")} to retry...`),
			d.readLine(),
			d.callFunction("check_and_run"),
		]),
	);
	return [...d.header(), "", ...check, "", ...loop, ""].join("\n");
}

/**
 * The setup/startup wrapper: run the project's setup script, then hand the view
 * to the agent wrapper.
 *
 * The tmux flavour puts the agent in a SECOND pane via `tmux split-window`,
 * which only works because the wrapper runs inside a dev3 tmux pane. A native
 * session has one view and no $TMUX, so there the setup script runs first and
 * then EXECs the agent in the same view — never a bare `tmux` shell-out, which
 * outside tmux would target the user's own default socket.
 */
export function buildSetupStartupWrapper(opts: {
	setupPath: string;
	cmdPath: string;
	worktreePath: string;
	shellPath: string;
	nativeBackend: boolean;
	launchMode: "parallel" | "blocking";
}): string {
	const d = launchDialect();
	const cmdRunner = d.runScript(opts.cmdPath, { shellPath: opts.shellPath });
	const setupDone = d.print(d.style("✓ Setup done", "success"));
	const runSetup = [
		d.runScript(opts.setupPath, { shellPath: opts.shellPath, trace: true }),
		d.captureExitCode("S"),
		...d.branchOnFailure("S", {
			fail: indentLines(2, [
				d.print(d.style("✗ Setup failed (exit %s)", "error"), { args: [d.exitCodeArg("S")] }),
				d.execReplacing(d.interactiveShellCommand(opts.shellPath)),
			]),
		}),
	];
	if (opts.nativeBackend) {
		return [...d.header(), ...runSetup, setupDone, d.execReplacing(cmdRunner)].join("\n") + "\n";
	}
	assertPosixLaunchDialect("the tmux setup/startup wrapper");
	const splitCmd = `tmux split-window -v -c "${escapeForDoubleQuotes(opts.worktreePath)}" "${escapeForDoubleQuotes(cmdRunner)}"`;
	return [
		...d.header(),
		...(opts.launchMode === "parallel" ? [splitCmd] : []),
		...runSetup,
		...(opts.launchMode === "blocking" ? [splitCmd] : []),
		setupDone,
		d.print(d.style("Closing in 15s — press any key to close now", "dim")),
		// Wrapper runs under the user's login shell (often zsh), so use a
		// shell-portable read — bash's `read -n 1 -s` crashes zsh.
		d.readKey({ timeoutSeconds: 15 }),
		"exit 0",
	].join("\n") + "\n";
}

const FALLBACK_BIN_PATHS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/opt/homebrew/sbin",
	"/usr/local/sbin",
	...(process.env.HOME ? [`${process.env.HOME}/.local/bin`, `${process.env.HOME}/bin`] : []),
];

/**
 * Known-good tmux kegs vendored via the h0x91b/dev3 Homebrew tap.
 *
 * tmux 3.7 regressed: its client busy-spins at 100% CPU on a congested server
 * socket (imsg flush loop) instead of waiting for writability, which cascades
 * into 10-35s UI freezes when several dev3 instances share one machine. The
 * dev3 cask/formula therefore depend on the keg-only `h0x91b/dev3/tmux@3.6`,
 * and the app prefers that keg over whatever `tmux` happens to be in PATH.
 * A user-configured custom path still wins over these.
 */
export const VENDORED_TMUX_PATHS = [
	"/opt/homebrew/opt/tmux@3.6/bin/tmux",
	"/usr/local/opt/tmux@3.6/bin/tmux",
	"/home/linuxbrew/.linuxbrew/opt/tmux@3.6/bin/tmux",
];

/**
 * Candidate locations of the tmux we bundle inside macOS artifacts
 * (decisions/137): DMG installs and the in-app updater cannot run brew, so
 * the app ships its own statically-linked tmux 3.6a. Pure so tests can cover
 * the layout math; `realExecDir` is the directory of the REAL on-disk binary
 * (realpath'd — brew symlinks bin/dev3 → libexec/dev3).
 *
 * Layouts:
 *  - app bundle: Contents/MacOS/<bun> → ../Resources/app/tmux/tmux
 *  - CLI tarball / brew libexec: <dir of dev3>/tmux/tmux
 */
export function bundledTmuxCandidates(platform: NodeJS.Platform, realExecDir: string | undefined): string[] {
	if (platform !== "darwin" || !realExecDir) return [];
	return [
		resolve(realExecDir, "..", "Resources", "app", "tmux", "tmux"),
		join(realExecDir, "tmux", "tmux"),
	];
}

function realExecDir(): string | undefined {
	try {
		return dirname(realpathSync(process.execPath));
	} catch {
		return undefined;
	}
}

/**
 * Full preference-ordered tmux search list (after a user's custom path):
 * bundled (self-contained, always version-pinned) → Homebrew tmux@3.6 keg →
 * then resolveBinaryPath falls through to PATH and the fallback bin dirs.
 */
export function tmuxSearchPaths(): string[] {
	return [...bundledTmuxCandidates(process.platform, realExecDir()), ...VENDORED_TMUX_PATHS];
}

export function binaryCandidatesOnPath(binaryName: string, path = process.env.PATH ?? ""): string[] {
	const directories = path
		.split(delimiter)
		.map((directory) => directory.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);
	return Array.from(new Set(directories.map((directory) => join(directory, binaryName))));
}

export function resolveBinaryPath(
	binaryName: string,
	customPath?: string,
	vendoredPaths?: string[],
): { resolvedPath?: string; customPathError: boolean } {
	let resolvedPath: string | undefined;
	let customPathError = false;

	if (customPath) {
		if (isExecutableFile(customPath)) {
			resolvedPath = customPath;
		} else {
			customPathError = true;
		}
	}

	if (!resolvedPath && vendoredPaths) {
		resolvedPath = vendoredPaths.find(isExecutableFile);
	}

	if (!resolvedPath) {
		const pathCandidate = whichSync(binaryName) ?? undefined;
		resolvedPath = pathCandidate && isExecutableFile(pathCandidate) ? pathCandidate : undefined;
	}

	if (!resolvedPath) {
		for (const dir of FALLBACK_BIN_PATHS) {
			const candidate = `${dir}/${binaryName}`;
			if (isExecutableFile(candidate)) {
				resolvedPath = candidate;
				if (!process.env.PATH?.split(delimiter).includes(dir)) {
					process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
				}
				break;
			}
		}
	}

	return { resolvedPath, customPathError };
}

let pushMessageRaw: ((name: string, payload: any) => void) | null = null;
let pushMessage: ((name: string, payload: any) => void) | null = null;

export function setPushMessage(fn: (name: string, payload: any) => void): void {
	pushMessageRaw = fn;
	pushMessage = (name, payload) => {
		fn(name, payload);
		if (name === "taskUpdated" || name === "projectUpdated" || name === "taskRemoved") {
			const params: Record<string, string> = { event: name };
			if (payload.projectId) params.projectId = payload.projectId;
			if (payload.project?.id) params.projectId = payload.project.id;
			if (payload.task?.id) params.taskId = payload.task.id;
			if (payload.taskId) params.taskId = payload.taskId;
			broadcastToOtherInstances(name, params);
		}
	};
}

export function getPushMessage(): ((name: string, payload: any) => void) | null {
	return pushMessage;
}

export function getPushMessageLocal(): ((name: string, payload: any) => void) | null {
	return pushMessageRaw;
}

export function isActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

export function buildAgentEnv(extraEnv: Record<string, string>, taskId: string): Record<string, string> {
	const dev3Bin = `${DEV3_HOME}/bin`;
	const currentPath = process.env.PATH || "";
	const pathWithDev3 = currentPath.includes(dev3Bin) ? currentPath : `${dev3Bin}:${currentPath}`;
	return { ...extraEnv, DEV3_TASK_ID: taskId, PATH: pathWithDev3 };
}

/**
 * Workspace env vars injected into every project hook (setup script, dev
 * script, cleanup script) and into agent sessions.
 *
 * `DEV3_PROJECT_PATH` is the load-bearing one for git-ignored hooks: a
 * `.dev3/config.local.json` lives only at the project root (a fresh worktree
 * checkout has no copy), so any script it references must be resolved from
 * the root — `"bash \"$DEV3_PROJECT_PATH/.dev3/setup.sh\""` — while the cwd
 * stays the worktree. This mirrors the Superset workspace-hook contract
 * (SUPERSET_ROOT_PATH / SUPERSET_WORKSPACE_NAME / SUPERSET_WORKSPACE_PATH),
 * which lets tooling such as the b44 CLI target both runners with the same
 * per-worktree setup/teardown scripts.
 *
 * `branchName` wins over `task.branchName` because at first launch the task
 * record is persisted only after the PTY starts — callers that just created
 * the worktree pass the fresh branch name explicitly.
 */
export function buildTaskLifecycleEnv(
	project: Project,
	task: Task,
	worktreePath: string,
	branchName?: string | null,
): Record<string, string> {
	return {
		DEV3_PROJECT_PATH: project.path,
		DEV3_PROJECT_NAME: project.name,
		DEV3_TASK_ID: task.id,
		DEV3_TASK_TITLE: task.title,
		DEV3_WORKTREE_PATH: worktreePath,
		DEV3_BRANCH_NAME: branchName ?? task.branchName ?? "",
	};
}

export function extractConfigFromParams(params: Record<string, any>): Record<string, any> {
	const config: Record<string, any> = {};
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		const val = params[key];
		if (val !== undefined) {
			config[key] = val;
		}
	}
	return config;
}

/** Whether a codex config.toml text declares `[model_providers.<id>]` (bare or
 *  quoted key, incl. an implicit parent via a `[model_providers.<id>.x]` subtable). */
export function hasModelProviderSection(toml: string, providerId: string): boolean {
	const id = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(String.raw`^\s*\[model_providers\.(?:"${id}"|'${id}'|${id})(?:\]|\.)`, "m");
	return re.test(toml);
}
