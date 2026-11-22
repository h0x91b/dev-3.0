import { describe, it, expect, vi, beforeEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const reaper = vi.hoisted(() => ({
	isPidAlive: vi.fn(() => true),
	getPidCwd: vi.fn(async (): Promise<string | null> => null),
	terminatePidsVerified: vi.fn(async () => []),
}));
vi.mock("../process-reaper", () => reaper);

import { findBazelOutputBase, removeBazelOutputBase } from "../bazel-output-base";

describe.skipIf(process.platform === "win32")("Bazel output base", () => {
	let root: string;
	let worktree: string;
	let outputBase: string;

	beforeEach(() => {
		vi.clearAllMocks();
		root = mkdtempSync(join(process.env.DEV3_TEST_ROOT!, "bazel-output-base-"));
		worktree = join(root, "worktree");
		outputBase = join(root, "_bazel_user", "md5");
		mkdirSync(worktree);
		mkdirSync(join(outputBase, "execroot", "_main", "bazel-out"), { recursive: true });
	});

	function writeReadme(workspace: string): void {
		writeFileSync(join(outputBase, "README"), `WORKSPACE: ${workspace}\n\nThe first line of this file is intentionally easy to parse\n`);
	}

	function linkBazelOut(target = join(outputBase, "execroot", "_main", "bazel-out")): void {
		symlinkSync(target, join(worktree, "bazel-out"));
	}

	describe("findBazelOutputBase", () => {
		it("follows bazel-out to the output base whose README names the worktree", () => {
			writeReadme(worktree);
			linkBazelOut();
			expect(findBazelOutputBase(worktree, [])).toEqual({ path: outputBase, workspace: worktree });
		});

		it("ignores an output base built for another workspace", () => {
			writeReadme("/elsewhere");
			linkBazelOut();
			expect(findBazelOutputBase(worktree, [])).toBeNull();
		});

		it("ignores a bazel-out that does not point into an execroot", () => {
			writeReadme(worktree);
			linkBazelOut(outputBase);
			expect(findBazelOutputBase(worktree, [])).toBeNull();
		});

		it("finds the output base by its md5-of-path name when bazel-out is missing", () => {
			const userRoot = join(root, "_bazel_user");
			const named = join(userRoot, createHash("md5").update(worktree).digest("hex"));
			mkdirSync(named);
			writeFileSync(join(named, "README"), `WORKSPACE: ${worktree}\n`);
			expect(findBazelOutputBase(worktree, [userRoot])).toEqual({ path: named, workspace: worktree });
		});

		it("ignores an md5-named output base built for another workspace", () => {
			const userRoot = join(root, "_bazel_user");
			const named = join(userRoot, createHash("md5").update(worktree).digest("hex"));
			mkdirSync(named);
			writeFileSync(join(named, "README"), "WORKSPACE: /elsewhere\n");
			expect(findBazelOutputBase(worktree, [userRoot])).toBeNull();
		});

		it("ignores a worktree Bazel never built", () => {
			expect(findBazelOutputBase(worktree, [])).toBeNull();
		});
	});

	describe("removeBazelOutputBase", () => {
		it("deletes a tree with read-only directories", async () => {
			const frozen = join(outputBase, "execroot", "_main", "bazel-out", "frozen");
			mkdirSync(frozen);
			writeFileSync(join(frozen, "Dump.class"), "");
			chmodSync(frozen, 0o555);

			await removeBazelOutputBase({ path: outputBase, workspace: worktree });

			expect(existsSync(outputBase)).toBe(false);
		});

		it("stops the Bazel server running from the workspace first", async () => {
			mkdirSync(join(outputBase, "server"));
			writeFileSync(join(outputBase, "server", "server.pid.txt"), "4242");
			reaper.getPidCwd.mockResolvedValue(worktree);

			await removeBazelOutputBase({ path: outputBase, workspace: worktree });

			expect(reaper.terminatePidsVerified).toHaveBeenCalledWith([4242]);
		});

		it("leaves a reused pid alone when it runs from somewhere else", async () => {
			mkdirSync(join(outputBase, "server"));
			writeFileSync(join(outputBase, "server", "server.pid.txt"), "4242");
			reaper.getPidCwd.mockResolvedValue("/somewhere/else");

			await removeBazelOutputBase({ path: outputBase, workspace: worktree });

			expect(reaper.terminatePidsVerified).not.toHaveBeenCalled();
			expect(existsSync(outputBase)).toBe(false);
		});
	});
});
