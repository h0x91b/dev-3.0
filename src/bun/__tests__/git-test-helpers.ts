/**
 * Shared test helpers for git.test.ts split files.
 *
 * Each test file must call vi.mock("../logger"), vi.mock("../paths"),
 * and vi.mock("../spawn") at the top level before importing git functions.
 * See git-merge-detection.test.ts for the reference pattern.
 */
import { execSync } from "child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn as cpSpawn } from "child_process";

// ─── Git helpers ─────────────────────────────────────────────────────────────

/**
 * Ignore the machine's git config so hooks, commit signing, templates or a custom
 * `init.defaultBranch` cannot change what these repos look like — locally or on CI.
 */
export const GIT_CONFIG_ISOLATION = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

export const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
	...GIT_CONFIG_ISOLATION,
};

export function g(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, env: GIT_ENV, stdio: "pipe", encoding: "utf-8" });
}

export interface TestRepo {
	dir: string;
	local: string;
}

// ── Template repo (created once per worker, cloned via cp -r for each test) ──
let _templateDir: string | null = null;

function getTemplateDir(): string {
	if (_templateDir) return _templateDir;

	const dir = mkdtempSync(join(tmpdir(), "dev3-git-template-"));
	const origin = join(dir, "origin.git");
	const local = join(dir, "local");

	g(`git init --bare "${origin}"`, dir);
	g(`git clone "${origin}" "${local}"`, dir);
	g("git config user.email test@test.com", local);
	g("git config user.name Test", local);

	writeFileSync(join(local, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	g("git add app.ts", local);
	g('git commit -m "initial"', local);
	g("git branch -M main", local);
	g("git push -u origin main", local);

	_templateDir = dir;
	return dir;
}

export function createTestRepo(): TestRepo {
	const template = getTemplateDir();
	const dir = mkdtempSync(join(tmpdir(), "dev3-git-test-"));
	// cpSync, not `cp -R`: these tests also run on Windows, where cmd.exe has no cp.
	cpSync(join(template, "origin.git"), join(dir, "origin.git"), { recursive: true });
	cpSync(join(template, "local"), join(dir, "local"), { recursive: true });
	const local = join(dir, "local");
	g(`git remote set-url origin "${join(dir, "origin.git")}"`, local);
	return { dir, local };
}

/**
 * Removing the repo in `afterEach` races any git subprocess the previous test left
 * running (git.ts coalesces fetches, so a call can outlive its caller): the child
 * then dies with ENOENT on a cwd that no longer exists and poisons an unrelated
 * test. Retire the directory instead and delete it once, after the worker's last
 * test — the template repo already lives for the whole worker.
 */
const retiredDirs: string[] = [];
let removalHookInstalled = false;

export function cleanup({ dir }: TestRepo): void {
	retiredDirs.push(dir);
	if (removalHookInstalled) return;
	removalHookInstalled = true;
	process.once("exit", () => {
		for (const retired of retiredDirs) rmSync(retired, { recursive: true, force: true });
		if (_templateDir) rmSync(_templateDir, { recursive: true, force: true });
	});
}

export function makeTaskCommits(local: string): void {
	writeFileSync(
		join(local, "feature.ts"),
		"export const add = (a: number, b: number) => a + b;\n",
	);
	g("git add feature.ts", local);
	g('git commit -m "feat: add function"', local);

	writeFileSync(
		join(local, "feature.ts"),
		"export const add = (a: number, b: number) => a + b;\n" +
			"export const sub = (a: number, b: number) => a - b;\n",
	);
	g("git add feature.ts", local);
	g('git commit -m "feat: add sub function"', local);
}

// ─── Spawn mock factory ─────────────────────────────────────────────────────

function emptyStream() {
	return new ReadableStream({ start: (controller) => controller.close() });
}

function toWebStream(readable: NodeJS.ReadableStream) {
	return new ReadableStream({
		start(controller) {
			readable.on("data", (chunk: Buffer) =>
				controller.enqueue(new Uint8Array(chunk)),
			);
			readable.on("end", () => controller.close());
			// A stream error is the child dying mid-read; close instead of erroring so
			// callers see an empty output plus the non-zero `exited`, never a rejection
			// surfacing as an unhandled error in an unrelated test.
			readable.on("error", () => {
				try {
					controller.close();
				} catch { /* already closed */ }
			});
		},
	});
}

function fakeProc(stdout: string, exitCode: number) {
	const encoder = new TextEncoder();
	return {
		exited: Promise.resolve(exitCode),
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stdout));
				controller.close();
			},
		}),
		stderr: new ReadableStream({ start(c) { c.close(); } }),
	};
}

/**
 * Every command the spawn mock was asked to run, in order. Lets a test assert
 * *how* something was executed (e.g. that no shell was involved).
 */
export const spawnedCommands: string[][] = [];

/** Node writable dressed up as Bun's FileSink, for `stdin: "pipe"` callers. */
function nodeStdinAsFileSink(stdin: NodeJS.WritableStream | null) {
	stdin?.on("error", () => { /* EPIPE when the child exits before we finish writing */ });
	return {
		write(chunk: Uint8Array) {
			stdin?.write(Buffer.from(chunk));
			return chunk.byteLength;
		},
		// Bun resolves flush() once the child drained the chunk; Node's write
		// callback fires at the same point, so an empty write is a fence.
		flush() {
			return new Promise<number>((resolve) => {
				if (!stdin || (stdin as NodeJS.WritableStream & { destroyed?: boolean }).destroyed) return resolve(0);
				stdin.write(Buffer.alloc(0), () => resolve(0));
			});
		},
		end() {
			stdin?.end();
		},
	};
}

/**
 * Creates a spawn mock that replaces Bun.spawn with Node.js child_process.
 * Optionally intercepts `gh` CLI calls with a custom response getter.
 */
export function createSpawnMock(getGhResponse?: () => string) {
	return {
		spawn: (cmd: string[], opts?: Record<string, unknown>) => {
			spawnedCommands.push([...cmd]);
			if (cmd[0] === "gh" && getGhResponse) {
				return fakeProc(getGhResponse(), 0);
			}

			const child = cpSpawn(cmd[0], cmd.slice(1), {
				cwd: opts?.cwd as string | undefined,
				// Isolation last: the machine's git config must not reach the code under test.
				env: { ...(opts?.env as NodeJS.ProcessEnv | undefined ?? process.env), ...GIT_CONFIG_ISOLATION },
				stdio: ["pipe", "pipe", "pipe"],
			});

			let sink: ReturnType<typeof nodeStdinAsFileSink> | undefined;
			if (opts?.stdin === "pipe") {
				sink = nodeStdinAsFileSink(child.stdin);
			} else if (opts?.stdin instanceof Blob) {
				(opts.stdin as Blob).arrayBuffer().then((buf) => {
					child.stdin?.write(Buffer.from(buf));
					child.stdin?.end();
				}).catch(() => { /* the child died before stdin was writable */ });
			} else {
				child.stdin?.end();
			}

			// A spawn that never starts (ENOENT because a previous test already removed
			// the cwd, EAGAIN under fork pressure…) emits `error`, not `close`. Without
			// this the ChildProcess raises an uncaught exception AND `exited` never
			// settles, so the awaiting test hangs until the suite-wide timeout instead
			// of failing with a readable message.
			const exited = new Promise<number>((resolve) => {
				child.on("close", (code: number | null) => resolve(code ?? 1));
				child.on("error", (err: NodeJS.ErrnoException) => {
					// Exit code 1 is indistinguishable from a real git failure, so the test
					// then dies on an assertion about git output and reads exactly like a
					// product regression. Name the real cause in the log — under fork
					// pressure this is EAGAIN, not the diff under test.
					console.error(`[git-test-helpers] spawn failed (${err.code ?? err.message}): ${cmd.join(" ")}`);
					resolve(1);
				});
			});

			return {
				exited,
				stdin: sink,
				stdout: child.stdout ? toWebStream(child.stdout) : emptyStream(),
				stderr: child.stderr ? toWebStream(child.stderr) : emptyStream(),
				kill: (signal?: number) => child.kill(signal as NodeJS.Signals | number | undefined),
			};
		},
	};
}
