import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildTaskDeepLink,
	buildProjectDeepLink,
	buildNewTaskDeepLink,
	buildTaskWebLink,
	DEEP_LINK_WEB_BASE,
} from "../../shared/deep-link";

/**
 * `docs/open.html` is a third copy of the dev3:// grammar — a plain <script> the
 * landing site serves, which cannot import the TypeScript module. Nothing else
 * would notice if the two drifted, so this pins the page's literals to what
 * `shared/deep-link.ts` actually builds today.
 */
const page = readFileSync(join(import.meta.dirname, "../../../docs/open.html"), "utf8");

describe("docs/open.html mirrors the deep-link grammar", () => {
	it("builds the same prefix for every link kind", () => {
		expect(page).toContain('"dev3://task/"');
		expect(page).toContain('"dev3://project/"');
		expect(page).toContain('"dev3://new-task"');
	});

	it("uses the same prefixes the module produces", () => {
		expect(buildTaskDeepLink("x")).toBe("dev3://task/x");
		expect(buildProjectDeepLink("x")).toBe("dev3://project/x");
		expect(buildNewTaskDeepLink()).toBe("dev3://new-task");
	});

	it("lives at the path the web link points to", () => {
		expect(buildTaskWebLink("x")).toBe(`${DEEP_LINK_WEB_BASE}/open.html?task=x`);
	});

	it("reads every query param the grammar defines", () => {
		for (const param of ["task", "project", "text", "new-task"]) {
			expect(page).toContain(`"${param}"`);
		}
	});

	it("resolves new-task before the branches that also read project", () => {
		expect(page.indexOf('p.has("new-task")')).toBeLessThan(page.indexOf('p.get("task")'));
	});
});
