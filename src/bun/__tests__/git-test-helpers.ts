/**
 * Shared test helpers for git.test.ts split files.
 *
 * Each test file must call vi.mock("../logger"), vi.mock("../paths"),
 * and vi.mock("../spawn") at the top level before importing git functions.
 * See git-merge-detection.test.ts for the reference pattern.
 */
import { vi } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn as cpSpawn } from "child_process";

// ─── Common mocks setup ─────────────────────────────────────────────────────

export function setupCommonMocks() {
	vi.mock("../logger", () => ({
		createLogger: () => ({
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		}),
	}));

	vi.mock("../paths", () => ({
		DEV3_HOME: "/tmp/dev3-test",
	}));
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

export const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
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
	execSync(`cp -R "${template}/origin.git" "${template}/local" "${dir}/"`, { stdio: "pipe" });
	const local = join(dir, "local");
	g(`git remote set-url origin "${join(dir, "origin.git")}"`, local);
	return { dir, local };
}

export function cleanup({ dir }: TestRepo): void {
	rmSync(dir, { recursive: true, force: true });
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

function toWebStream(readable: NodeJS.ReadableStream) {
	return new ReadableStream({
		start(controller) {
			readable.on("data", (chunk: Buffer) =>
				controller.enqueue(new Uint8Array(chunk)),
			);
			readable.on("end", () => controller.close());
			readable.on("error", (err: Error) => controller.error(err));
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
 * Creates a spawn mock that replaces Bun.spawn with Node.js child_process.
 * Optionally intercepts `gh` CLI calls with a custom response getter.
 */
export function createSpawnMock(getGhResponse?: () => string) {
	return {
		spawn: (cmd: string[], opts?: Record<string, unknown>) => {
			if (cmd[0] === "gh" && getGhResponse) {
				return fakeProc(getGhResponse(), 0);
			}

			const child = cpSpawn(cmd[0], cmd.slice(1), {
				cwd: opts?.cwd as string | undefined,
				env: (opts?.env as NodeJS.ProcessEnv | undefined) ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			if (opts?.stdin instanceof Blob) {
				(opts.stdin as Blob).arrayBuffer().then((buf) => {
					child.stdin!.write(Buffer.from(buf));
					child.stdin!.end();
				});
			} else {
				child.stdin?.end();
			}

			return {
				exited: new Promise<number>((resolve) =>
					child.on("close", (code: number | null) => resolve(code ?? 1)),
				),
				stdout: toWebStream(child.stdout!),
				stderr: toWebStream(child.stderr!),
			};
		},
	};
}
