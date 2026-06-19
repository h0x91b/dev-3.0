import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

import { writeFileSync } from "fs";
import { join } from "path";
import { createTestRepo, cleanup, g, type TestRepo } from "./git-test-helpers";
import { getTaskDiff, _resetFetchState } from "../git";

// Exercises the cat-file batch reader end-to-end against a real repo: multiple
// blobs at both refs (positional parse alignment), plus large/binary skips
// classified without ever spawning a per-file process.
describe("getTaskDiff batched content reads", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("reads many files in one batch and skips large/binary blobs", async () => {
		// Several text files committed on top of origin/main, plus a large and a
		// binary file that must land in skippedFiles.
		const large = "x\n".repeat(200_000); // ~400 KB > MAX_INLINE_DIFF_FILE_BYTES
		writeFileSync(join(repo.local, "alpha.ts"), "export const a = 1;\n");
		writeFileSync(join(repo.local, "beta.ts"), "export const b = 2;\nexport const c = 3;\n");
		writeFileSync(join(repo.local, "big.txt"), large);
		writeFileSync(join(repo.local, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
		g("git add -A", repo.local);
		g('git commit -m "add a bunch of files"', repo.local);

		const result = await getTaskDiff(repo.local, "branch", {
			baseBranch: "main",
			compareRef: "origin/main",
		});

		const byPath = new Map(result.files.map((f) => [f.displayPath, f]));
		expect(byPath.get("alpha.ts")?.newContent).toBe("export const a = 1;\n");
		expect(byPath.get("alpha.ts")?.insertions).toBe(1);
		expect(byPath.get("beta.ts")?.newContent).toBe("export const b = 2;\nexport const c = 3;\n");
		expect(byPath.get("beta.ts")?.insertions).toBe(2);
		// Hunks are never computed server-side anymore.
		expect(result.files.every((f) => f.hunks === null)).toBe(true);

		const skippedByPath = new Map(result.skippedFiles.map((f) => [f.displayPath, f]));
		expect(skippedByPath.get("big.txt")?.reason).toBe("too-large");
		expect(skippedByPath.get("bin.dat")?.reason).toBe("binary");
	});
});
