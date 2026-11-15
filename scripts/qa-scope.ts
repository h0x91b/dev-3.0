/**
 * Scoped data root for a QA app instance (`bun run dev --qa`).
 *
 * WHY: an instance started for browser verification renders the developer's whole
 * real board, so another task's "Branch Merged — mark completed?" dialog is live
 * and clickable and another task's live terminal is one navigation away. Two vents
 * reported an agent aborting its verification rather than risk the click. Pointing
 * `$DEV3_HOME` at a throwaway root removes the reachability instead of gating it:
 * the other tasks are not in this instance's data at all.
 *
 * Two fixtures, because there are two jobs:
 *   - `seeded`  — one throwaway git project, no tasks. The QA default.
 *   - `virgin`  — nothing at all. The state a brand-new user is in, which nobody
 *                 could reach before without risking their real data.
 *
 * The redirect never touches the real `~/.dev3.0` — no rename, no move, no
 * delete, nothing read out of it. See
 * `decisions/2026/08/21/scoped-qa-app-instance.md`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_TMUX_SOCKET } from "../src/bun/tmux/constants";
import type { Project } from "../src/shared/types";

export type QaScopeMode = "seeded" | "virgin";

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Stable per worktree AND per mode, so a restart reuses the same scoped board
 * instead of handing back a fresh one, and the seeded fixture can never leak into
 * a virgin first-run. Deliberately NOT keyed by pid, unlike `test-isolation.ts`.
 */
export function qaScopeRoot(worktreeRoot: string, mode: QaScopeMode, tempRoot = tmpdir()): string {
	const id = createHash("sha256").update(safeRealpath(worktreeRoot)).digest("hex").slice(0, 12);
	return join(tempRoot, "dev3-qa", id, mode);
}

/**
 * `DEV3_HOME`, `DEV3_LOG_DIR` and `TMUX_TMPDIR` are redirected. `TMUX_TMPDIR` gives
 * the instance its own tmux server: every tmux it spawns, task panes included,
 * inherits it, so nothing lands on the real app's server. Kept short, because a
 * macOS socket path stops at 104 bytes. `HOME` deliberately stays
 * real: the agent's own `dev3` CLI, git and module resolution all read it, and
 * moving it would break the QA run rather than isolate it. `DEV3_TEST_ROOT` (the
 * OS scratch root behind `dev3TempPath`) also stays real — task scratch files are
 * not board state, and folding them in here would put them inside the data root.
 */
export function qaScopeEnv(root: string): Record<string, string> {
	return {
		DEV3_HOME: join(root, "home", ".dev3.0").replaceAll("\\", "/"),
		DEV3_LOG_DIR: join(root, "logs").replaceAll("\\", "/"),
		TMUX_TMPDIR: join(root, "t").replaceAll("\\", "/"),
	};
}

export function qaFixtureRepo(root: string): string {
	return join(root, "fixture-repo");
}

/**
 * One throwaway git project and NO tasks. A task the QA run needs is created
 * through the UI, which is both safe here and a real exercise of the flow —
 * hand-seeding `tasks.json` would only add a fixture whose shape can drift from
 * the `Task` type without anything noticing.
 */
export function qaFixtureProject(repoPath: string, createdAt: string): Project {
	return {
		id: "0da3f0a0-0000-4000-8000-000000000001",
		name: "QA Fixture",
		path: repoPath.replaceAll("\\", "/"),
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt,
		portCount: 0,
	};
}

export type QaScopeRunner = (command: string[], cwd: string) => void;

/** Injectable: vitest stubs the Bun runtime, so a real spawn is not available there. */
const bunRunner: QaScopeRunner = (command, cwd) => {
	const result = Bun.spawnSync(command, { cwd, stdout: "ignore", stderr: "pipe", env: process.env });
	if (result.exitCode !== 0) {
		const detail = result.stderr ? new TextDecoder().decode(result.stderr).trim() : "";
		throw new Error(`[qa-scope] ${command.join(" ")} failed (exit ${result.exitCode}) ${detail}`);
	}
};

/**
 * Idempotent, and non-destructive on purpose: an existing scoped root is reused
 * as-is, board state included. Re-virginising is a deliberate `rm -rf` of the
 * printed root, never a silent wipe on start — a mode that erases state every
 * boot cannot show what a returning first-run user sees.
 */
export function seedQaScope(
	root: string,
	mode: QaScopeMode,
	now = new Date().toISOString(),
	run: QaScopeRunner = bunRunner,
): Record<string, string> {
	const env = qaScopeEnv(root);
	// The data root, log dir and tmux dir are created even for `virgin`: an absent parent is
	// not "a new user", it is a different failure, and the app creates this dir on
	// first run anyway.
	for (const dir of [env.DEV3_HOME, env.DEV3_LOG_DIR, env.TMUX_TMPDIR]) mkdirSync(dir, { recursive: true });
	if (mode === "virgin") return env;

	const repo = qaFixtureRepo(root);
	mkdirSync(repo, { recursive: true });
	if (!existsSync(join(repo, ".git"))) {
		run(["git", "init", "--initial-branch=main"], repo);
		run(["git", "config", "user.email", "qa@dev3.invalid"], repo);
		run(["git", "config", "user.name", "dev3 QA fixture"], repo);
		writeFileSync(join(repo, "README.md"), "Throwaway repo for scoped dev3 QA. Safe to delete.\n");
		run(["git", "add", "README.md"], repo);
		run(["git", "commit", "-m", "QA fixture"], repo);
	}

	const projectsFile = join(env.DEV3_HOME, "projects.json");
	if (!existsSync(projectsFile)) {
		writeFileSync(projectsFile, `${JSON.stringify([qaFixtureProject(repo, now)], null, 2)}\n`);
	}
	return env;
}

export function qaTmuxSocketDir(env: Record<string, string>, uid = process.getuid?.() ?? 0): string {
	return join(env.TMUX_TMPDIR, `tmux-${uid}`);
}

/**
 * The scoped app's own tmux shim when it wrote one, so the client matches the
 * server's version; PATH `tmux` otherwise.
 */
export function qaTmuxBinary(env: Record<string, string>): string {
	const shim = join(env.DEV3_HOME, "bin", "tmux");
	return existsSync(shim) ? shim : "tmux";
}

/** What to run, before `rm -rf`, so a reset does not orphan the scoped server. */
export function qaScopeResetHint(root: string, env: Record<string, string>): string {
	const socket = join(qaTmuxSocketDir(env), DEFAULT_TMUX_SOCKET);
	return `${qaTmuxBinary(env)} -S ${socket} kill-server; rm -rf ${root}`;
}

export type QaTmuxKiller = (command: string[]) => void;

const bunKiller: QaTmuxKiller = (command) => {
	Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore", env: process.env, timeout: 3_000 });
};

/**
 * Stop every tmux server in the scoped socket directory. The directory belongs
 * to this scope alone, so nothing in it can be the real app's server. Best
 * effort: a server that does not answer is left to the reset hint.
 */
export function stopQaScopeTmux(
	env: Record<string, string>,
	kill: QaTmuxKiller = bunKiller,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform === "win32") return [];
	const dir = qaTmuxSocketDir(env);
	let sockets: string[];
	try {
		sockets = readdirSync(dir);
	} catch {
		return [];
	}
	const binary = qaTmuxBinary(env);
	for (const socket of sockets) kill([binary, "-S", join(dir, socket), "kill-server"]);
	return sockets;
}
