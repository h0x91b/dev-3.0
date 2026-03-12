/**
 * Tests for fetchOrigin (dedup/cooldown logic) and saveDiffSnapshot
 * using mocked spawn() responses. No real git repos needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Project, Task } from "../../shared/types";

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

let spawnResponses: Array<{ exitCode: number; stdout: string; stderr: string }> = [];

function queueResponse(exitCode: number, stdout: string, stderr = "") {
	spawnResponses.push({ exitCode, stdout, stderr });
}

vi.mock("../spawn", () => ({
	spawn: () => {
		const response = spawnResponses.shift() ?? { exitCode: 1, stdout: "", stderr: "no response queued" };
		const encoder = new TextEncoder();
		return {
			exited: Promise.resolve(response.exitCode),
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(response.stdout));
					controller.close();
				},
			}),
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(response.stderr));
					controller.close();
				},
			}),
		};
	},
}));

import {
	fetchOrigin,
	_resetFetchState,
	saveDiffSnapshot,
	taskDir,
} from "../git";

beforeEach(() => {
	spawnResponses = [];
	_resetFetchState();
});

// ─── fetchOrigin ─────────────────────────────────────────────────────────────

describe("fetchOrigin", () => {
	it("returns true on successful fetch", async () => {
		queueResponse(0, "");
		const ok = await fetchOrigin("/repo");
		expect(ok).toBe(true);
	});

	it("returns false when fetch fails", async () => {
		queueResponse(128, "", "fatal: no remote");
		const ok = await fetchOrigin("/repo");
		expect(ok).toBe(false);
	});

	it("deduplicates concurrent fetches for the same project", async () => {
		// Only one spawn call should happen despite 3 concurrent requests
		queueResponse(0, "");
		const results = await Promise.all([
			fetchOrigin("/repo"),
			fetchOrigin("/repo"),
			fetchOrigin("/repo"),
		]);
		expect(results).toEqual([true, true, true]);
		// Only 1 response consumed — the other 2 reused the same promise
		expect(spawnResponses).toHaveLength(0);
	});

	it("skips fetch within cooldown period", async () => {
		queueResponse(0, "");
		const ok1 = await fetchOrigin("/repo");
		expect(ok1).toBe(true);

		// Second call should skip (no spawn needed)
		const ok2 = await fetchOrigin("/repo");
		expect(ok2).toBe(true);
	});

	it("allows fetch for different projects concurrently", async () => {
		queueResponse(0, ""); // for /repo-a
		queueResponse(0, ""); // for /repo-b
		const [ok1, ok2] = await Promise.all([
			fetchOrigin("/repo-a"),
			fetchOrigin("/repo-b"),
		]);
		expect(ok1).toBe(true);
		expect(ok2).toBe(true);
		expect(spawnResponses).toHaveLength(0); // both consumed
	});
});

// ─── saveDiffSnapshot ────────────────────────────────────────────────────────

describe("saveDiffSnapshot", () => {
	let tmpDir: string;
	const project: Project = { id: "proj-1", name: "Test", path: "" } as Project;
	const task: Task = { id: "task-1000-0000-0000" } as Task;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dev3-snap-test-"));
		project.path = tmpDir;
		(task as { worktreePath: string }).worktreePath = tmpDir;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saves a .patch file when there are changes", async () => {
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "diff --git a/feature.ts b/feature.ts\n+export const add = 1;\n");
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		expect(existsSync(diffsDir)).toBe(true);

		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(1);

		const content = readFileSync(join(diffsDir, files[0]), "utf-8");
		expect(content).toContain("feature.ts");
	});

	it("skips saving when there is no diff", async () => {
		queueResponse(0, ""); // empty shortstat → no diff
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(0);
	});

	it("skips saving when diff is unchanged from the last snapshot", async () => {
		const diffContent = "diff --git a/f.ts b/f.ts\n+line\n";
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, diffContent);
		await saveDiffSnapshot(project, task, "origin/main");

		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, diffContent); // same diff
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(1);
	});

	it("saves a new file when diff changes", async () => {
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "diff v1\n");
		await saveDiffSnapshot(project, task, "origin/main");

		// Advance time to get a different timestamp
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.advanceTimersByTime(60_000);
		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "diff v2\n");
		await saveDiffSnapshot(project, task, "origin/main");
		vi.useRealTimers();

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(2);
	});

	it("prunes old snapshots beyond MAX_DIFF_SNAPSHOTS", async () => {
		const diffsDir = join(taskDir(project, task), "diffs");
		mkdirSync(diffsDir, { recursive: true });

		for (let i = 0; i < 55; i++) {
			const name = `2025-01-01T00-00-${String(i).padStart(2, "0")}.patch`;
			writeFileSync(join(diffsDir, name), `patch-${i}`);
		}

		queueResponse(0, " 1 file changed, 1 insertion(+)"); // shortstat
		queueResponse(0, "new diff content\n");
		await saveDiffSnapshot(project, task, "origin/main");

		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files.length).toBeLessThanOrEqual(50);
	});

	it("skips saving when shortstat estimates diff exceeds 1 MB", async () => {
		// 20000 insertions × 80 bytes/line = ~1.6 MB → exceeds 1 MB limit
		queueResponse(0, " 100 files changed, 20000 insertions(+), 5000 deletions(-)");
		// No second spawn should happen — pre-check aborts early
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(0);
	});

	it("skips saving when actual diff exceeds 1 MB despite small shortstat estimate", async () => {
		// shortstat looks small but actual diff is huge (e.g. binary-like content)
		queueResponse(0, " 1 file changed, 10 insertions(+)"); // shortstat
		queueResponse(0, "x".repeat(1_100_000) + "\n"); // actual diff exceeds limit
		await saveDiffSnapshot(project, task, "origin/main");

		const diffsDir = join(taskDir(project, task), "diffs");
		const files = readdirSync(diffsDir).filter((f: string) => f.endsWith(".patch"));
		expect(files).toHaveLength(0);
	});
});
