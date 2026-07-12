import {
	hexToRgb,
	titleFromDescription,
	extractRepoName,
	formatStatus,
	ALL_STATUSES,
	ACTIVE_STATUSES,
	STATUS_LABELS,
	STATUS_COLORS,
	STATUS_COLORS_LIGHT,
	DEFAULT_AGENTS,
	DEFAULT_EXTERNAL_APPS,
	getPrimaryStopTarget,
	LABEL_COLORS,
	isBuiltinOpsProject,
	orderProjectsForDisplay,
	computeTaskTimeBreakdown,
} from "../../shared/types";
import type { Project, TaskStatus, TaskTimeInput } from "../../shared/types";

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

describe("getPrimaryStopTarget", () => {
	it("defaults to review-by-user when automatic review is disabled", () => {
		expect(getPrimaryStopTarget(false)).toBe("review-by-user");
		expect(getPrimaryStopTarget(undefined)).toBe("review-by-user");
	});

	it("returns review-by-ai when automatic review is enabled", () => {
		expect(getPrimaryStopTarget(true)).toBe("review-by-ai");
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

	it("includes the Composer 2.5 Cursor configuration", () => {
		const cursor = DEFAULT_AGENTS.find((a) => a.id === "builtin-cursor");
		expect(cursor).toBeDefined();
		expect(cursor!.configurations).toContainEqual({
			id: "cursor-composer-2-5",
			name: "Composer 2.5",
			model: "composer-2.5",
		});
	});

	it("uses the pinned Sonnet 5 model in Sonnet 5 presets", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude");
		expect(claude).toBeDefined();

		const sonnetConfigs = claude!.configurations.filter((config) => config.id.includes("-sonnet5"));
		expect(sonnetConfigs.length).toBeGreaterThan(0);
		for (const config of sonnetConfigs) {
			expect(config.model).toBe("claude-sonnet-5");
			expect(config.version).toBeGreaterThan(0);
		}
	});

	it("uses a high bypass preset as the default Codex configuration", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex");
		expect(codex).toBeDefined();

		const cfg = codex!.configurations.find((c) => c.id === "codex-default");
		expect(cfg).toBeDefined();
		expect(cfg!.name).toBe("GPT-5.6 Sol Bypass [High] — Default");
		expect(cfg!.model).toBe("gpt-5.6-sol");
		expect(cfg!.additionalArgs).toContain("--sandbox");
		expect(cfg!.additionalArgs).toContain("danger-full-access");
		expect(cfg!.additionalArgs).toContain('model_reasoning_effort="high"');
		expect(cfg!.additionalArgs).not.toContain('default_permissions="dev3"');
	});

	it("curates GPT-5.6 Codex models and modes in Anthropic-style order", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex");
		expect(codex).toBeDefined();

		const modelOrder = codex!.configurations
			.map((config) => config.model)
			.filter((model, index, models) => model != null && models.indexOf(model) === index);
		expect(modelOrder).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);

		const modesFor = (model: string) => codex!.configurations
			.filter((config) => config.model === model)
			.map((config) => config.modeLabel);
		expect(modesFor("gpt-5.6-sol")).toEqual([
			"Bypass [High] — Default",
			"Bypass [Medium]", "Bypass [X-High]", "Bypass [Max]", "Bypass [Ultra]",
			"Standard [Medium]", "Standard [High]",
			"Plan [High]", "Plan → Bypass [High]",
		]);
		expect(modesFor("gpt-5.6-terra")).toEqual([
			"Bypass [Medium]", "Bypass [High]", "Bypass [X-High]",
			"Standard [Medium]", "Standard [High]",
		]);
		expect(modesFor("gpt-5.6-luna")).toEqual([
			"Bypass [Low]", "Bypass [Medium]", "Bypass [High]",
			"Standard [Low]", "Standard [Medium]",
		]);
		expect(modesFor("gpt-5.5")).toEqual([
			"Bypass [Medium]", "Bypass [High]",
			"Standard [Medium]", "Standard [High]",
		]);
	});

	it("configures every generated GPT-5.6 Codex mode with matching effort and permissions", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const generated = codex.configurations.filter((config) => config.id.startsWith("codex-5.6-"));
		for (const config of generated) {
			const effort = config.modeLabel!.match(/\[([^\]]+)\]/)![1].toLowerCase().replace("x-high", "xhigh");
			expect(config.additionalArgs).toContain(`model_reasoning_effort="${effort}"`);
			if (config.modeLabel!.startsWith("Bypass")) {
				expect(config.additionalArgs).toContain("danger-full-access");
				expect(config.additionalArgs).not.toContain('default_permissions="dev3"');
			} else {
				expect(config.additionalArgs).toContain('default_permissions="dev3"');
				expect(config.additionalArgs).not.toContain("danger-full-access");
			}
		}
	});
});

// ---- Constants: DEFAULT_EXTERNAL_APPS ----

describe("DEFAULT_EXTERNAL_APPS", () => {
	it("includes PyCharm as a built-in external app", () => {
		expect(DEFAULT_EXTERNAL_APPS).toContainEqual({
			id: "pycharm",
			name: "PyCharm",
			macAppName: "PyCharm",
		});
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

// ---- formatStatus ----

describe("formatStatus", () => {
	it("humanizes hyphenated status slugs", () => {
		expect(formatStatus("in-progress")).toBe("In Progress");
		expect(formatStatus("review-by-user")).toBe("Review By User");
		expect(formatStatus("review-by-ai")).toBe("Review By Ai");
	});

	it("capitalizes single-word statuses", () => {
		expect(formatStatus("todo")).toBe("Todo");
		expect(formatStatus("completed")).toBe("Completed");
		expect(formatStatus("cancelled")).toBe("Cancelled");
	});
});

// ---- isBuiltinOpsProject / orderProjectsForDisplay ----

const proj = (over: Partial<Project>): Project => ({
	id: "p",
	name: "P",
	path: "/p",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
	...over,
});

describe("isBuiltinOpsProject", () => {
	it("is true only for a virtual project flagged builtin", () => {
		expect(isBuiltinOpsProject(proj({ kind: "virtual", builtin: true }))).toBe(true);
	});

	it("is false for user-created virtual boards (builtin unset)", () => {
		expect(isBuiltinOpsProject(proj({ kind: "virtual" }))).toBe(false);
	});

	it("is false for a git project even if builtin somehow set", () => {
		expect(isBuiltinOpsProject(proj({ kind: "git", builtin: true }))).toBe(false);
		expect(isBuiltinOpsProject(proj({}))).toBe(false);
	});
});

describe("orderProjectsForDisplay", () => {
	it("pins the built-in Operations board first, preserving the rest of the order", () => {
		const a = proj({ id: "a" });
		const b = proj({ id: "b" });
		const ops = proj({ id: "ops", kind: "virtual", builtin: true });
		expect(orderProjectsForDisplay([a, b, ops]).map((p) => p.id)).toEqual(["ops", "a", "b"]);
		expect(orderProjectsForDisplay([a, ops, b]).map((p) => p.id)).toEqual(["ops", "a", "b"]);
	});

	it("returns the list unchanged when there is no built-in board", () => {
		const a = proj({ id: "a" });
		const v = proj({ id: "v", kind: "virtual" });
		const input = [a, v];
		expect(orderProjectsForDisplay(input)).toBe(input);
	});
});

// ---- computeTaskTimeBreakdown ----

describe("computeTaskTimeBreakdown", () => {
	const HOUR = 3_600_000;
	const MIN = 60_000;
	const NOW = Date.parse("2026-07-05T12:00:00.000Z");
	const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

	it("uses finalized durations for a terminal (completed) task", () => {
		const task: TaskTimeInput = {
			status: "completed",
			createdAt: iso(4 * HOUR),
			movedAt: iso(1 * HOUR), // total lifetime = 3h
			statusDurations: { "in-progress": 90 * MIN, "review-by-ai": 30 * MIN, "review-by-user": 20 * MIN },
			statusEnteredAt: iso(1 * HOUR),
			focusMs: 25 * MIN,
		};
		const tb = computeTaskTimeBreakdown(task, NOW);
		expect(tb.totalMs).toBe(3 * HOUR);
		expect(tb.agentMs).toBe(90 * MIN + 30 * MIN);
		expect(tb.userMs).toBe(20 * MIN);
		expect(tb.focusMs).toBe(25 * MIN);
		expect(tb.hasStatusTracking).toBe(true);
	});

	it("credits the live portion of the current status for an active task", () => {
		const task: TaskTimeInput = {
			status: "in-progress",
			createdAt: iso(2 * HOUR),
			statusDurations: { "in-progress": 30 * MIN }, // prior in-progress stint
			statusEnteredAt: iso(15 * MIN), // entered current in-progress 15m ago
			focusMs: 10 * MIN,
		};
		const tb = computeTaskTimeBreakdown(task, NOW);
		expect(tb.totalMs).toBe(2 * HOUR); // create → now (active)
		expect(tb.agentMs).toBe(30 * MIN + 15 * MIN); // prior + live 15m
	});

	it("reports total time but zero agent/user split for legacy tasks", () => {
		const task: TaskTimeInput = {
			status: "completed",
			createdAt: iso(90 * MIN),
			movedAt: iso(30 * MIN),
		};
		const tb = computeTaskTimeBreakdown(task, NOW);
		expect(tb.totalMs).toBe(60 * MIN);
		expect(tb.agentMs).toBe(0);
		expect(tb.userMs).toBe(0);
		expect(tb.hasStatusTracking).toBe(false);
	});

	it("never credits the sit-time of a terminal status", () => {
		// A completed task's statusEnteredAt is old, but 'completed' isn't an agent/
		// user status and the live portion is not credited for terminal tasks.
		const task: TaskTimeInput = {
			status: "completed",
			createdAt: iso(3 * HOUR),
			movedAt: iso(2 * HOUR),
			statusDurations: { "in-progress": 60 * MIN },
			statusEnteredAt: iso(2 * HOUR),
		};
		const tb = computeTaskTimeBreakdown(task, NOW);
		expect(tb.agentMs).toBe(60 * MIN);
	});
});
