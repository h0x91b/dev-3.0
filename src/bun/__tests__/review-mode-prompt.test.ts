import { describe, it, expect } from "vitest";
import { resolveReviewModePrompt } from "../../shared/types";

const BUILTIN = "Review the code changes on this branch.";

describe("resolveReviewModePrompt", () => {
	it("falls back to the localized built-in text when nothing is configured", () => {
		expect(resolveReviewModePrompt(null, null, BUILTIN)).toBe(BUILTIN);
		expect(resolveReviewModePrompt({}, {}, BUILTIN)).toBe(BUILTIN);
	});

	it("uses the global prompt when only that is set", () => {
		expect(resolveReviewModePrompt({}, { reviewModePrompt: "Global." }, BUILTIN)).toBe("Global.");
	});

	it("lets the project override the global prompt", () => {
		expect(
			resolveReviewModePrompt({ reviewModePrompt: "Project." }, { reviewModePrompt: "Global." }, BUILTIN),
		).toBe("Project.");
	});

	it("treats a blank value at either layer as unset", () => {
		expect(
			resolveReviewModePrompt({ reviewModePrompt: "   \n" }, { reviewModePrompt: "Global." }, BUILTIN),
		).toBe("Global.");
		expect(resolveReviewModePrompt({ reviewModePrompt: "" }, { reviewModePrompt: "  " }, BUILTIN)).toBe(BUILTIN);
	});

	it("keeps a configured prompt verbatim, trailing whitespace included", () => {
		expect(resolveReviewModePrompt({ reviewModePrompt: "Project.\n\n" }, null, BUILTIN)).toBe("Project.\n\n");
	});
});
