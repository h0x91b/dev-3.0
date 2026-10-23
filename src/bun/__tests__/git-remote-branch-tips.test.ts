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

import { getRemoteBranchTips } from "../git";
import { GIT_CONFIG_ISOLATION } from "./git-test-helpers";

const IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.com" };

function sh(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, env: { ...process.env, ...IDENTITY, ...GIT_CONFIG_ISOLATION }, stdio: "pipe", encoding: "utf-8" }).trim();
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dev3-remote-tips-"));
	sh("git init -q -b main && git commit -q --allow-empty -m one && git commit -q --allow-empty -m two", dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("getRemoteBranchTips", () => {
	it("returns what every remote last had for the branch, and nothing for other branches", async () => {
		const [two, one] = sh("git rev-list HEAD", dir).split("\n");
		sh(`git update-ref refs/remotes/origin/main ${two} && git update-ref refs/remotes/fork/feat/x ${one} && git update-ref refs/remotes/origin/feat/x ${two}`, dir);

		expect((await getRemoteBranchTips(dir, "feat/x")).sort()).toEqual([one, two].sort());
	});

	it("ignores a deeper path that only ends the same way", async () => {
		const [two] = sh("git rev-list HEAD", dir).split("\n");
		sh(`git update-ref refs/remotes/a/b/feat/x ${two}`, dir);

		expect(await getRemoteBranchTips(dir, "feat/x")).toEqual([]);
	});

	it("is empty when the branch was never pushed", async () => {
		expect(await getRemoteBranchTips(dir, "feat/x")).toEqual([]);
	});
});
