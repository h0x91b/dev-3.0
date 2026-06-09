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

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
// Same 10 lines but with a single line changed → ~90% similar content.
const TEN_LINES_ONE_CHANGED = TEN_LINES.replace("line 5", "line 5 CHANGED");

describe("getTaskDiff rename detection", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("reports a renamed-with-edits file as a single rename, not delete + add", async () => {
		// Worst case for the previous implementation: the user disabled rename
		// detection globally. The diff must still detect the rename because the
		// flag is now passed explicitly.
		g("git config diff.renames false", repo.local);

		writeFileSync(join(repo.local, "module.ts"), TEN_LINES);
		g("git add module.ts", repo.local);
		g('git commit -m "add module"', repo.local);

		g("git mv module.ts renamed.ts", repo.local);
		writeFileSync(join(repo.local, "renamed.ts"), TEN_LINES_ONE_CHANGED);
		g("git add -A", repo.local);

		const result = await getTaskDiff(repo.local, "uncommitted", { baseBranch: "main" });

		const renamed = result.files.filter((f) => f.status === "renamed");
		const deleted = result.files.filter((f) => f.status === "deleted");
		const added = result.files.filter((f) => f.status === "added");

		expect(renamed).toHaveLength(1);
		expect(deleted).toHaveLength(0);
		expect(added).toHaveLength(0);

		const entry = renamed[0];
		expect(entry.oldPath).toBe("module.ts");
		expect(entry.newPath).toBe("renamed.ts");

		// The patch must contain only the single changed line, not the whole file.
		const patch = (entry.hunks ?? []).join("\n");
		const addedLines = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
		const removedLines = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
		expect(addedLines).toHaveLength(1);
		expect(removedLines).toHaveLength(1);
		expect(addedLines[0]).toContain("line 5 CHANGED");
	});

	it("detects a rename with a moderate edit below the old 90% threshold", async () => {
		// ~70% similar: 3 of 10 lines changed. The previous 90% threshold split
		// this into delete + add; git's default 50% threshold pairs them.
		writeFileSync(join(repo.local, "service.ts"), TEN_LINES);
		g("git add service.ts", repo.local);
		g('git commit -m "add service"', repo.local);

		const moderatelyEdited = TEN_LINES
			.replace("line 2", "line 2 X")
			.replace("line 5", "line 5 Y")
			.replace("line 8", "line 8 Z");
		g("git mv service.ts moved-service.ts", repo.local);
		writeFileSync(join(repo.local, "moved-service.ts"), moderatelyEdited);
		g("git add -A", repo.local);

		const result = await getTaskDiff(repo.local, "uncommitted", { baseBranch: "main" });

		const renamed = result.files.filter((f) => f.status === "renamed");
		expect(renamed).toHaveLength(1);
		expect(renamed[0].oldPath).toBe("service.ts");
		expect(renamed[0].newPath).toBe("moved-service.ts");
		expect(result.files.some((f) => f.status === "deleted" || f.status === "added")).toBe(false);
	});
});
