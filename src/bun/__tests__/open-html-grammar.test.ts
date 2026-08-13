import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Issue #1340, item 6: the dev3:// grammar lives in three places — the TypeScript
// build/parse in src/shared/deep-link.ts, and a hand-written JS copy inside the
// public redirect page docs/open.html that no other test guards. A grammar change
// in TypeScript would pass CI while the page kept redirecting to the old shape.
// This is the minimum guard: assert the page still emits every scheme prefix.
const OPEN_HTML = readFileSync(
	fileURLToPath(new URL("../../../docs/open.html", import.meta.url)),
	"utf8",
);

describe("docs/open.html redirect grammar", () => {
	it("emits all three dev3:// scheme prefixes", () => {
		expect(OPEN_HTML).toContain('"dev3://task/"');
		expect(OPEN_HTML).toContain('"dev3://project/"');
		expect(OPEN_HTML).toContain('"dev3://new-task"');
	});

	// Item 4: new-task is the only kind that also reads `project`, so its branch
	// must be reached before the project branch, or ?new-task&project=… is swallowed.
	it("dispatches new-task before project", () => {
		const newTaskAt = OPEN_HTML.indexOf('p.has("new-task")');
		const projectAt = OPEN_HTML.indexOf('p.get("project")');
		expect(newTaskAt).toBeGreaterThan(-1);
		expect(projectAt).toBeGreaterThan(-1);
		expect(newTaskAt).toBeLessThan(projectAt);
	});
});
