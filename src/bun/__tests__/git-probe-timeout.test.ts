import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { execSync } from "child_process";
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestRepo, cleanup, g, spawnedCommands, type TestRepo } from "./git-test-helpers";
import { isWorktreeDirty, run, _setGitProbeTimeoutForTest } from "../git";

// A wedged fsmonitor: `git status` waits on the hook forever, and the hook's own
// child survives a signal sent to git alone (#2153).
function wedgeFsmonitor(repo: TestRepo, marker: number): void {
	const hook = join(repo.dir, "hang-fsmonitor.sh");
	writeFileSync(hook, `#!/bin/sh\nsleep ${marker}\n`);
	chmodSync(hook, 0o755);
	g(`git config core.fsmonitor "${hook}"`, repo.local);
}

function processesWith(marker: number): number {
	const ps = execSync("ps -axo command=", { encoding: "utf-8" });
	return ps.split("\n").filter((line) => line.includes(`sleep ${marker}`)).length;
}

async function waitUntilGone(marker: number, budgetMs: number): Promise<number> {
	const deadline = Date.now() + budgetMs;
	while (processesWith(marker) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	return processesWith(marker);
}

const statusSpawns = () => spawnedCommands.filter((cmd) => cmd.includes("status")).length;

describe.skipIf(process.platform === "win32")("git probes cannot outlive their caller", () => {
	let repo: TestRepo;
	let marker: number;

	beforeEach(() => {
		repo = createTestRepo();
		marker = 900_000 + Math.floor(Math.random() * 99_999);
		wedgeFsmonitor(repo, marker);
		spawnedCommands.length = 0;
		_setGitProbeTimeoutForTest(400);
	});

	afterEach(() => {
		_setGitProbeTimeoutForTest(null);
		try { execSync(`pkill -f "sleep ${marker}"`); } catch { /* none left */ }
		cleanup(repo);
	});

	it("times out a status that never answers and kills the whole process group", async () => {
		const result = await run(["git", "status", "--porcelain"], repo.local);

		expect(result).toMatchObject({ ok: false, timedOut: true });
		expect(await waitUntilGone(marker, 3_000)).toBe(0);
	});

	it("reads a status that never finished as dirty, not clean", async () => {
		expect(await isWorktreeDirty(repo.local)).toBe(true);
	});

	it("lets concurrent pollers of one worktree share a single git status", async () => {
		const answers = await Promise.all(Array.from({ length: 5 }, () => isWorktreeDirty(repo.local)));

		expect(answers).toEqual([true, true, true, true, true]);
		expect(statusSpawns()).toBe(1);
		expect(await waitUntilGone(marker, 3_000)).toBe(0);
	});

	it("starts a fresh status once the previous one has settled", async () => {
		await isWorktreeDirty(repo.local);
		await isWorktreeDirty(repo.local);

		expect(statusSpawns()).toBe(2);
	});

	it("leaves an explicit caller timeout in charge", async () => {
		g("git config --unset core.fsmonitor", repo.local);
		const result = await run(["git", "status", "--porcelain"], repo.local, { timeoutMs: 10_000 });

		expect(result).toEqual({ ok: true, stdout: "", stderr: "" });
	});
});
