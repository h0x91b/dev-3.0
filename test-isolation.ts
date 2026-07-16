import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function testWorktreeId(worktreeRoot: string): string {
	return createHash("sha256").update(safeRealpath(worktreeRoot)).digest("hex").slice(0, 12);
}

export function deriveTestRunRoot(
	worktreeRoot: string,
	suite: string,
	pid: number,
	tempRoot = tmpdir(),
): string {
	const safeSuite = suite.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(tempRoot, "dev3-tests", testWorktreeId(worktreeRoot), `${safeSuite}-${pid}`);
}

/**
 * Move every implicit user/global path used by a test process into a sandbox.
 * The worktree hash prevents parallel worktrees from sharing resources; the
 * suite and PID also isolate concurrently repeated runs in one worktree.
 */
export function configureTestIsolation(suite: string, worktreeRoot = process.cwd()): string {
	const originalTempRoot = tmpdir();
	const root = deriveTestRunRoot(worktreeRoot, suite, process.pid, originalTempRoot);
	const home = join(root, "home");
	const dev3Home = join(home, ".dev3.0");
	const temp = join(root, "tmp");
	const runtime = join(root, "runtime");
	const xdgConfig = join(root, "xdg-config");
	const xdgCache = join(root, "xdg-cache");
	const xdgData = join(root, "xdg-data");
	const xdgState = join(root, "xdg-state");

	for (const dir of [home, dev3Home, temp, runtime, xdgConfig, xdgCache, xdgData, xdgState]) {
		mkdirSync(dir, { recursive: true });
	}

	Object.assign(process.env, {
		DEV3_TEST_ROOT: root,
		DEV3_TEST_WORKTREE_ID: testWorktreeId(worktreeRoot),
		DEV3_HOME: dev3Home,
		DEV3_LOG_DIR: join(root, "logs"),
		HOME: home,
		TMPDIR: temp,
		TMP: temp,
		TEMP: temp,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_CACHE_HOME: xdgCache,
		XDG_DATA_HOME: xdgData,
		XDG_STATE_HOME: xdgState,
		XDG_RUNTIME_DIR: runtime,
	});

	return root;
}

export function cleanupTestIsolation(root: string): void {
	if (!root.includes(`${join("dev3-tests", "")}`)) {
		throw new Error(`Refusing to clean a non-test path: ${root}`);
	}
	rmSync(root, { recursive: true, force: true });
}
