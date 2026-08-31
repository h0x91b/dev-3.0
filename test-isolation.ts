import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDev3Home } from "./src/shared/dev3-home";

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

/**
 * The longest a unix socket path may be. macOS caps `sun_path` at 104 bytes
 * including the terminating NUL; Linux allows 108. The smaller number is the
 * one every fixture has to fit, and it is a HARD kernel limit — a path over it
 * fails to bind with a bare EINVAL that reads like a broken fixture.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/**
 * Where a test may put a unix socket, as opposed to any other fixture.
 *
 * The isolated run root lives under the platform temp dir, and on macOS that is
 * a ~48-byte `/var/folders/...` path before a test adds anything — deep enough
 * that an ordinary fixture name blows the socket limit above. So sockets get
 * their own short root, bounded BY CONSTRUCTION rather than by how short this
 * machine's temp dir happens to be. Windows has no such limit and no
 * world-writable `/tmp`, so it keeps its sockets inside the run root.
 */
export function deriveTestSocketRoot(worktreeRoot: string, suite: string, pid: number, tempRoot = tmpdir()): string {
	const safeSuite = suite.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 8);
	const base = process.platform === "win32" ? join(tempRoot, "dev3-tests") : "/tmp";
	return join(base, "d3s", testWorktreeId(worktreeRoot).slice(0, 8), `${safeSuite}-${pid}`);
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
 * The only `DEV3_*` namespace a test process may inherit.
 *
 * Every other `DEV3_*` var dev3 exports into an agent pane is a redirect into the
 * REAL user environment — its data home, its project checkout, its worktree, its
 * ports, its task, its native-terminal host — and a suite started from such a
 * pane inherits all of them. So the rule is default-deny: drop every `DEV3_*`
 * var and keep only this prefix, which belongs to the test harness itself
 * (`DEV3_TEST_CONCURRENT`, set by the `bun run test` scripts, is read by the
 * Vitest config immediately after this returns).
 *
 * A named scrub list is what let `DEV3_HOME` through. It OUTRANKS `HOME` in
 * `resolveDev3Home`, so a pane exporting it pointed every backend suite at the
 * live `~/.dev3.0` at module load — while the list went on faithfully scrubbing
 * the six task-context vars it did know about. Under default-deny a newly added
 * var is safe without anyone remembering this file.
 */
export const PRESERVED_TEST_ENV_PREFIX = "DEV3_TEST_";

/** Prefix of everything the scrub considers, so both sides read the same word. */
export const DEV3_ENV_PREFIX = "DEV3_";

/** The vars dev3 actually injects into an agent pane, for the guard test to
 *  prove the scrub against. Illustrative, NOT the scrub's input — the scrub is
 *  a prefix rule, so this list going stale cannot reopen the hole. */
export const PANE_INJECTED_ENV_SAMPLE = [
	"DEV3_HOME",
	"DEV3_TASK_ID",
	"DEV3_TASK_SEQ",
	"DEV3_TASK_TITLE",
	"DEV3_PANE_ID",
	"DEV3_WORKTREE_PATH",
	"DEV3_WORKTREE_ROOT",
	"DEV3_BRANCH_NAME",
	"DEV3_PROJECT_PATH",
	"DEV3_PROJECT_NAME",
	"DEV3_ARTIFACT_TEMPLATE_DIR",
	"DEV3_AGENT_ACCOUNT_ID",
	"DEV3_USER_ENV",
	"DEV3_CLI_SOCKET",
	"DEV3_NATIVE_SESSION_ID",
	"DEV3_NATIVE_SESSIONS_DIR",
	"DEV3_PORT0",
] as const;

/**
 * Move every implicit user/global path used by a test process into a sandbox.
 * The worktree hash prevents parallel worktrees from sharing resources; the
 * suite and PID also isolate concurrently repeated runs in one worktree.
 */
export function configureTestIsolation(suite: string, worktreeRoot = process.cwd()): string {
	const originalTempRoot = tmpdir();
	const root = deriveTestRunRoot(worktreeRoot, suite, process.pid, originalTempRoot);
	const socketRoot = deriveTestSocketRoot(worktreeRoot, suite, process.pid, originalTempRoot);
	const home = join(root, "home");
	const dev3Home = join(home, ".dev3.0");
	const temp = join(root, "tmp");
	const runtime = join(root, "runtime");
	const xdgConfig = join(root, "xdg-config");
	const xdgCache = join(root, "xdg-cache");
	const xdgData = join(root, "xdg-data");
	const xdgState = join(root, "xdg-state");

	for (const dir of [home, dev3Home, temp, runtime, xdgConfig, xdgCache, xdgData, xdgState, socketRoot]) {
		mkdirSync(dir, { recursive: true });
	}

	for (const key of Object.keys(process.env)) {
		if (key.startsWith(DEV3_ENV_PREFIX) && !key.startsWith(PRESERVED_TEST_ENV_PREFIX)) {
			delete process.env[key];
		}
	}

	// DEV3_HOME is SCRUBBED above and deliberately not set again: the data root is
	// derived from HOME by `resolveDev3Home`, so the sandbox HOME below already
	// lands it at `dev3Home`. Setting it would make it OUTRANK a suite's own
	// `process.env.HOME = fixtureHome`, which is how dozens of suites relocate the
	// board — they would read this run's shared root instead of their fixture.
	Object.assign(process.env, {
		DEV3_TEST_ROOT: root,
		DEV3_TEST_SOCKET_ROOT: socketRoot,
		DEV3_TEST_WORKTREE_ID: testWorktreeId(worktreeRoot),
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

	assertDev3HomeIsSandboxed(root);
	return root;
}

/**
 * The outcome check, as opposed to the mechanism above: whatever the environment
 * arrived as, the data root the code will actually use has to be inside this
 * run's sandbox. Throwing here aborts the whole Vitest process before a single
 * suite loads a module, which is the difference between a loud refusal to start
 * and a run that quietly writes into the user's live `~/.dev3.0`.
 *
 * Resolved through the production resolver on purpose — asserting against a
 * locally recomposed path would pass even if the resolver's precedence changed.
 */
export function assertDev3HomeIsSandboxed(root: string): void {
	const resolved = resolveDev3Home();
	if (resolved.startsWith(root.replaceAll("\\", "/"))) return;
	throw new Error(
		`Test isolation failed: dev3 home resolved to ${resolved}, outside the run root ${root}. ` +
			`Refusing to run — a suite would write to the real user data root.`,
	);
}

export function cleanupTestIsolation(root: string, socketRoot?: string): void {
	if (!root.includes(`${join("dev3-tests", "")}`)) {
		throw new Error(`Refusing to clean a non-test path: ${root}`);
	}
	rmSync(root, { recursive: true, force: true });
	if (!socketRoot) return;
	if (!socketRoot.includes(`${join("d3s", "")}`)) {
		throw new Error(`Refusing to clean a non-socket-root path: ${socketRoot}`);
	}
	rmSync(socketRoot, { recursive: true, force: true });
}
