import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { join } from "path";

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

import { cloneRepo } from "../git";
import { createTestRepo, cleanup, type TestRepo } from "./git-test-helpers";

describe("cloneRepo", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("clones a repo and streams progress lines to onProgress", async () => {
		const target = join(repo.dir, "cloned");
		const updates: string[][] = [];

		const result = await cloneRepo(join(repo.dir, "origin.git"), target, (lines) => updates.push(lines));

		expect(result).toEqual({ ok: true, path: target });
		expect(existsSync(join(target, ".git"))).toBe(true);
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.flat().join("\n")).toContain("Cloning into");
	});

	it("returns a terminal-style error tail when the clone fails", async () => {
		const target = join(repo.dir, "cloned-fail");

		const result = await cloneRepo(join(repo.dir, "no-such-repo"), target);

		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		expect(result.error).not.toContain("\r");
	});
});
