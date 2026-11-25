/** `getRemoteBranchTips` against real git: it reads ref names, which a mocked spawn cannot show. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-test" }));
vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { commitExists, getRemoteBranchTips } from "../git";
import { GIT_CONFIG_ISOLATION } from "./git-test-helpers";

const IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.com" };

function sh(cmd: string, cwd: string, env: Record<string, string> = {}): string {
	return execSync(cmd, { cwd, env: { ...process.env, ...IDENTITY, ...GIT_CONFIG_ISOLATION, ...env }, stdio: "pipe", encoding: "utf-8" }).trim();
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dev3-remote-tips-"));
	sh("git init -q -b main && git commit -q --allow-empty -m one && git commit -q --allow-empty -m two", dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setRef = (ref: string, sha: string, at: number) =>
	sh(`git update-ref refs/remotes/${ref} ${sha}`, dir, { GIT_COMMITTER_DATE: `@${at} +0000` });

describe("getRemoteBranchTips", () => {
	it("returns only the ref updated most recently, and nothing for other branches", async () => {
		const [two, one] = sh("git rev-list HEAD", dir).split("\n");
		setRef("origin/main", two, 1_000);
		setRef("fork/feat/x", one, 2_000);
		setRef("origin/feat/x", two, 3_000);

		expect(await getRemoteBranchTips(dir, "feat/x")).toEqual({ tips: [two], ambiguous: false });
		const three = sh("git commit -q --allow-empty -m three && git rev-parse HEAD", dir);
		setRef("fork/feat/x", three, 4_000);
		expect(await getRemoteBranchTips(dir, "feat/x")).toEqual({ tips: [three], ambiguous: false });
	});

	it("is ambiguous when the newest refs tie on time with different commits", async () => {
		const [two, one] = sh("git rev-list HEAD", dir).split("\n");
		setRef("fork/feat/x", one, 2_000);
		setRef("origin/feat/x", two, 2_000);

		const res = await getRemoteBranchTips(dir, "feat/x");
		expect(res.ambiguous).toBe(true);
		expect(res.tips.sort()).toEqual([one, two].sort());
	});

	it("is one tip when the tied newest refs hold the same commit", async () => {
		const [two, one] = sh("git rev-list HEAD", dir).split("\n");
		setRef("fork/feat/x", one, 1_000);
		setRef("fork2/feat/x", two, 2_000);
		setRef("origin/feat/x", two, 2_000);

		expect(await getRemoteBranchTips(dir, "feat/x")).toEqual({ tips: [two], ambiguous: false });
	});

	it("is ambiguous with no reflog times and different commits, and one tip when they agree", async () => {
		const [two, one] = sh("git rev-list HEAD", dir).split("\n");
		sh("git config core.logAllRefUpdates false", dir);
		setRef("fork/feat/x", one, 1_000);
		setRef("origin/feat/x", two, 1_000);
		expect((await getRemoteBranchTips(dir, "feat/x")).ambiguous).toBe(true);

		setRef("fork/feat/x", two, 1_000);
		expect(await getRemoteBranchTips(dir, "feat/x")).toEqual({ tips: [two], ambiguous: false });
	});

	it("is empty for a never-pushed branch, ignores a deeper path that only ends the same way, and returns a single ref as is", async () => {
		expect(await getRemoteBranchTips(dir, "feat/x"), "never pushed").toEqual({ tips: [], ambiguous: false });

		const [two] = sh("git rev-list HEAD", dir).split("\n");
		setRef("a/b/feat/x", two, 2_000);
		expect(await getRemoteBranchTips(dir, "feat/x"), "deeper path").toEqual({ tips: [], ambiguous: false });

		setRef("origin/feat/x", two, 2_000);
		expect(await getRemoteBranchTips(dir, "feat/x"), "single ref").toEqual({ tips: [two], ambiguous: false });
	});
});

describe("commitExists", () => {
	it("is true for a commit in the repository and false for an unknown one", async () => {
		const [two] = sh("git rev-list HEAD", dir).split("\n");
		expect(await commitExists(dir, two)).toBe(true);
		expect(await commitExists(dir, "f".repeat(40))).toBe(false);
	});
});
