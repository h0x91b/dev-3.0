import {
	hexToRgb,
	titleFromDescription,
	extractRepoName,
	ALL_STATUSES,
	ACTIVE_STATUSES,
	STATUS_LABELS,
	STATUS_COLORS,
	STATUS_COLORS_LIGHT,
	DEFAULT_AGENTS,
	LABEL_COLORS,
} from "../../shared/types";
import type { TaskStatus } from "../../shared/types";

// ---- hexToRgb ----

describe("hexToRgb", () => {
	it("converts standard hex color to RGB string", () => {
		expect(hexToRgb("#ff8040")).toBe("255 128 64");
	});

	it("converts black", () => {
		expect(hexToRgb("#000000")).toBe("0 0 0");
	});

	it("converts white", () => {
		expect(hexToRgb("#ffffff")).toBe("255 255 255");
	});

	it("converts pure red", () => {
		expect(hexToRgb("#ff0000")).toBe("255 0 0");
	});

	it("converts pure green", () => {
		expect(hexToRgb("#00ff00")).toBe("0 255 0");
	});

	it("converts pure blue", () => {
		expect(hexToRgb("#0000ff")).toBe("0 0 255");
	});

	it("handles lowercase hex digits", () => {
		expect(hexToRgb("#aabbcc")).toBe("170 187 204");
	});

	it("handles uppercase hex digits", () => {
		expect(hexToRgb("#AABBCC")).toBe("170 187 204");
	});
});

// ---- titleFromDescription ----

describe("titleFromDescription", () => {
	it("returns short text unchanged", () => {
		expect(titleFromDescription("Fix login bug")).toBe("Fix login bug");
	});

	it("returns empty string unchanged", () => {
		expect(titleFromDescription("")).toBe("");
	});

	it("returns text at exactly maxLen unchanged", () => {
		const text = "a".repeat(80);
		expect(titleFromDescription(text)).toBe(text);
	});

	it("truncates long text at word boundary with ellipsis", () => {
		const words = "word ".repeat(20).trim(); // 99 chars
		const result = titleFromDescription(words, 50);
		expect(result.endsWith("\u2026")).toBe(true);
		expect(result.length).toBeLessThanOrEqual(51); // 50 + ellipsis
		// Should cut at a space boundary
		expect(result.slice(0, -1).endsWith(" ")).toBe(false);
	});

	it("truncates without word boundary when last space is too early", () => {
		// Create text where the only space is very early (< 40% of maxLen)
		const text = "Hi " + "x".repeat(100);
		const result = titleFromDescription(text, 50);
		expect(result).toBe(text.slice(0, 50) + "\u2026");
	});

	it("replaces newlines with spaces", () => {
		expect(titleFromDescription("line1\nline2\nline3")).toBe(
			"line1 line2 line3",
		);
	});

	it("trims whitespace", () => {
		expect(titleFromDescription("  hello  ")).toBe("hello");
	});

	it("respects custom maxLen", () => {
		const text = "one two three four five six seven";
		const result = titleFromDescription(text, 15);
		expect(result.endsWith("\u2026")).toBe(true);
		expect(result.length).toBeLessThanOrEqual(16);
	});

	it("handles text with only newlines and spaces", () => {
		expect(titleFromDescription("\n\n  \n")).toBe("");
	});

	it("truncates at last space when it falls after 40% threshold", () => {
		// "aaaa bbbbb ccccc ddddd eeeee" = 29 chars, maxLen=20
		// slice(0,20) = "aaaa bbbbb ccccc ddd", lastSpace at index 15
		// 15 > 20*0.4=8, so it should cut at space
		const text = "aaaa bbbbb ccccc ddddd eeeee";
		const result = titleFromDescription(text, 20);
		expect(result).toBe("aaaa bbbbb ccccc\u2026");
	});
});

// ---- extractRepoName ----

describe("extractRepoName", () => {
	it("extracts name from HTTPS URL with .git", () => {
		expect(extractRepoName("https://github.com/user/my-repo.git")).toBe("my-repo");
	});

	it("extracts name from HTTPS URL without .git", () => {
		expect(extractRepoName("https://github.com/user/my-repo")).toBe("my-repo");
	});

	it("extracts name from SSH URL", () => {
		expect(extractRepoName("git@github.com:user/my-repo.git")).toBe("my-repo");
	});

	it("handles trailing slashes", () => {
		expect(extractRepoName("https://github.com/user/my-repo/")).toBe("my-repo");
	});

	it("handles multiple trailing slashes", () => {
		expect(extractRepoName("https://github.com/user/my-repo///")).toBe("my-repo");
	});

	it("handles trailing slash and .git", () => {
		expect(extractRepoName("https://github.com/user/my-repo.git/")).toBe("my-repo");
	});

	it("returns fallback for empty input", () => {
		expect(extractRepoName("")).toBe("cloned-repo");
	});

	it("extracts from GitLab-style nested URL", () => {
		expect(extractRepoName("https://gitlab.com/group/subgroup/project.git")).toBe("project");
	});
});

// ---- Constants: ALL_STATUSES ----

describe("ALL_STATUSES", () => {
	it("contains all 8 statuses", () => {
		expect(ALL_STATUSES).toHaveLength(8);
	});

	it("includes every expected status", () => {
		const expected: TaskStatus[] = [
			"todo",
			"in-progress",
			"user-questions",
			"review-by-user",
			"review-by-colleague",
			"review-by-ai",
			"completed",
			"cancelled",
		];
		for (const s of expected) {
			expect(ALL_STATUSES).toContain(s);
		}
	});

	it("has no duplicates", () => {
		expect(new Set(ALL_STATUSES).size).toBe(ALL_STATUSES.length);
	});
});

// ---- Constants: ACTIVE_STATUSES ----

describe("ACTIVE_STATUSES", () => {
	it("is a subset of ALL_STATUSES", () => {
		for (const s of ACTIVE_STATUSES) {
			expect(ALL_STATUSES).toContain(s);
		}
	});

	it("does not include terminal statuses", () => {
		expect(ACTIVE_STATUSES).not.toContain("todo");
		expect(ACTIVE_STATUSES).not.toContain("completed");
		expect(ACTIVE_STATUSES).not.toContain("cancelled");
	});

	it("includes all work-in-progress statuses", () => {
		expect(ACTIVE_STATUSES).toContain("in-progress");
		expect(ACTIVE_STATUSES).toContain("user-questions");
		expect(ACTIVE_STATUSES).toContain("review-by-user");
		expect(ACTIVE_STATUSES).toContain("review-by-ai");
	});
});

// ---- Constants: STATUS_LABELS ----

describe("STATUS_LABELS", () => {
	it("has a label for every status in ALL_STATUSES", () => {
		for (const s of ALL_STATUSES) {
			expect(STATUS_LABELS[s]).toBeDefined();
			expect(typeof STATUS_LABELS[s]).toBe("string");
			expect(STATUS_LABELS[s].length).toBeGreaterThan(0);
		}
	});
});

// ---- Constants: STATUS_COLORS ----

describe("STATUS_COLORS", () => {
	it("has a color for every status in ALL_STATUSES", () => {
		for (const s of ALL_STATUSES) {
			expect(STATUS_COLORS[s]).toBeDefined();
		}
	});

	it("all colors are valid hex format", () => {
		for (const s of ALL_STATUSES) {
			expect(STATUS_COLORS[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
		}
	});
});

// ---- Constants: STATUS_COLORS_LIGHT ----

describe("STATUS_COLORS_LIGHT", () => {
	it("has a color for every status in ALL_STATUSES", () => {
		for (const s of ALL_STATUSES) {
			expect(STATUS_COLORS_LIGHT[s]).toBeDefined();
		}
	});

	it("all colors are valid hex format", () => {
		for (const s of ALL_STATUSES) {
			expect(STATUS_COLORS_LIGHT[s]).toMatch(/^#[0-9a-fA-F]{6}$/);
		}
	});

	it("has different colors from dark theme", () => {
		for (const s of ALL_STATUSES) {
			expect(STATUS_COLORS_LIGHT[s]).not.toBe(STATUS_COLORS[s]);
		}
	});
});

// ---- Constants: DEFAULT_AGENTS ----

describe("DEFAULT_AGENTS", () => {
	it("contains at least one agent", () => {
		expect(DEFAULT_AGENTS.length).toBeGreaterThan(0);
	});

	it("each agent has required fields", () => {
		for (const agent of DEFAULT_AGENTS) {
			expect(agent.id).toBeTruthy();
			expect(agent.name).toBeTruthy();
			expect(agent.baseCommand).toBeTruthy();
			expect(Array.isArray(agent.configurations)).toBe(true);
			expect(agent.configurations.length).toBeGreaterThan(0);
		}
	});

	it("each configuration has id and name", () => {
		for (const agent of DEFAULT_AGENTS) {
			for (const config of agent.configurations) {
				expect(config.id).toBeTruthy();
				expect(config.name).toBeTruthy();
			}
		}
	});

	it("defaultConfigId references a valid configuration", () => {
		for (const agent of DEFAULT_AGENTS) {
			if (agent.defaultConfigId) {
				const ids = agent.configurations.map((c) => c.id);
				expect(ids).toContain(agent.defaultConfigId);
			}
		}
	});

	it("includes Claude agent", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude");
		expect(claude).toBeDefined();
		expect(claude!.baseCommand).toBe("claude");
	});
});

// ---- Constants: LABEL_COLORS ----

describe("LABEL_COLORS", () => {
	it("has 12 colors", () => {
		expect(LABEL_COLORS).toHaveLength(12);
	});

	it("all colors are valid hex format", () => {
		for (const color of LABEL_COLORS) {
			expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
		}
	});

	it("all colors are unique", () => {
		expect(new Set(LABEL_COLORS).size).toBe(LABEL_COLORS.length);
	});
});
