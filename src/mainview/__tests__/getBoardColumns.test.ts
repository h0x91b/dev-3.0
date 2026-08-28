import { getBoardColumns, laneAcceptsProject, laneColumnIdForProject } from "../../shared/types";
import type { BoardColumnSlot, CustomColumn, Project } from "../../shared/types";

type ProjectInput = Parameters<typeof getBoardColumns>[0][number];
type BoardOpts = Parameters<typeof getBoardColumns>[1];

/**
 * A board whose subject is ONE project. Every case below asserts through it: a
 * set of one must keep producing exactly what a project board renders today.
 */
const one = (p: ProjectInput, opts?: BoardOpts) => getBoardColumns([p], opts);

function customCol(id: string, name = id): CustomColumn {
	return { id, name, color: "#123456", llmInstruction: `move here for ${name}` };
}

/** Flatten slots to comparable tokens: builtin → status, custom → `custom:<id>`. */
function tokens(slots: BoardColumnSlot[]): string[] {
	return slots.map((s) => (s.type === "builtin" ? s.status : `custom:${s.col.id}`));
}

function project(overrides: Partial<Project> = {}): ProjectInput {
	return { id: "p1", ...overrides } as ProjectInput;
}

describe("getBoardColumns", () => {
	it("default git board (no columnOrder, no custom) — all built-ins in lifecycle order", () => {
		expect(tokens(one(project()))).toEqual([
			"todo",
			"in-progress",
			"user-questions",
			"review-by-ai",
			"review-by-user",
			"review-by-colleague",
			"completed",
			"cancelled",
		]);
	});

	it("custom columns are interspersed between review-by-user and review-by-colleague by default", () => {
		const cols = [customCol("deploy"), customCol("qa")];
		expect(tokens(one(project({ customColumns: cols })))).toEqual([
			"todo",
			"in-progress",
			"user-questions",
			"review-by-ai",
			"review-by-user",
			"custom:deploy",
			"custom:qa",
			"review-by-colleague",
			"completed",
			"cancelled",
		]);
	});

	it("peerReviewEnabled === false hides the PR Review (review-by-colleague) column", () => {
		const result = tokens(one(project({ peerReviewEnabled: false })));
		expect(result).not.toContain("review-by-colleague");
		expect(result).toContain("review-by-user");
	});

	it("AI Review hides when builtinColumnAgents is defined without a review-by-ai entry and empty", () => {
		const result = tokens(one(project({ builtinColumnAgents: {} })));
		expect(result).not.toContain("review-by-ai");
	});

	it("AI Review stays visible (even when disabled) if it currently has items", () => {
		const result = tokens(
			one(project({ builtinColumnAgents: {} }), { occupiedStatuses: new Set(["review-by-ai"] as const) }),
		);
		expect(result).toContain("review-by-ai");
	});

	// An occupied column that hides takes its cards off the board for good: they
	// stay in tasks.json and stay visible to the CLI, and a restart does not bring
	// them back. Never hide a column that holds tasks.
	it("PR Review stays visible with peer review off if it currently has items", () => {
		const result = tokens(
			one(project({ peerReviewEnabled: false }), {
				occupiedStatuses: new Set(["review-by-colleague"] as const),
			}),
		);
		expect(result).toContain("review-by-colleague");
	});

	it("virtual board keeps an occupied AI Review / PR Review column", () => {
		const result = tokens(
			one(project({ kind: "virtual" }), {
				occupiedStatuses: new Set(["review-by-ai", "review-by-colleague"] as const),
			}),
		);
		expect(result).toContain("review-by-ai");
		expect(result).toContain("review-by-colleague");
	});

	it("occupancy of an unrelated column does not resurrect a hidden one", () => {
		const result = tokens(
			one(project({ peerReviewEnabled: false }), { occupiedStatuses: new Set(["todo"] as const) }),
		);
		expect(result).not.toContain("review-by-colleague");
	});

	it("a hidden column stays hidden when it is listed in a stored columnOrder", () => {
		const result = tokens(
			one(project({ peerReviewEnabled: false, columnOrder: ["todo", "review-by-colleague", "completed"] })),
		);
		expect(result).not.toContain("review-by-colleague");
	});

	it("an occupied column listed in a stored columnOrder keeps its stored position", () => {
		const result = tokens(
			one(
				project({ peerReviewEnabled: false, columnOrder: ["todo", "review-by-colleague", "completed"] }),
				{ occupiedStatuses: new Set(["review-by-colleague"] as const) },
			),
		);
		expect(result.slice(0, 3)).toEqual(["todo", "review-by-colleague", "completed"]);
	});

	it("virtual (Operations) board hides both AI Review and PR Review", () => {
		const result = tokens(one(project({ kind: "virtual" })));
		expect(result).toEqual(["todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled"]);
	});

	it("respects an explicit columnOrder, placing custom columns where listed", () => {
		const cols = [customCol("deploy")];
		// columnOrder holds raw ids: built-in status strings + custom column ids.
		const result = tokens(
			one(project({ customColumns: cols, columnOrder: ["todo", "deploy", "in-progress"] })),
		);
		// Ordered head follows columnOrder; the rest are appended afterwards.
		expect(result.slice(0, 3)).toEqual(["todo", "custom:deploy", "in-progress"]);
		expect(result).toContain("user-questions");
		expect(result).toContain("completed");
	});

	it("re-inserts review-by-ai before review-by-user when absent from a stored columnOrder", () => {
		const result = tokens(one(project({ columnOrder: ["todo", "in-progress", "review-by-user"] })));
		const aiIdx = result.indexOf("review-by-ai");
		const userIdx = result.indexOf("review-by-user");
		expect(aiIdx).toBeGreaterThanOrEqual(0);
		expect(aiIdx).toBeLessThan(userIdx);
	});

	it("re-inserts review-by-colleague before completed when absent from a stored columnOrder", () => {
		const result = tokens(one(project({ columnOrder: ["todo", "completed"] })));
		const colleagueIdx = result.indexOf("review-by-colleague");
		const completedIdx = result.indexOf("completed");
		expect(colleagueIdx).toBeGreaterThanOrEqual(0);
		expect(colleagueIdx).toBeLessThan(completedIdx);
	});

	it("skips a columnOrder entry that references a non-existent custom column", () => {
		const result = tokens(one(project({ columnOrder: ["todo", "ghost-column", "in-progress"] })));
		expect(result).not.toContain("custom:ghost-column");
		expect(result).toContain("todo");
		expect(result).toContain("in-progress");
	});
});

// ---- The board's subject is a SET of projects (the unified space board) ----

describe("getBoardColumns across several projects", () => {
	function p(id: string, overrides: Partial<Project> = {}): ProjectInput {
		return { id, ...overrides } as ProjectInput;
	}

	/** Which projects contribute to each custom lane, by lane name. */
	function laneMembers(slots: BoardColumnSlot[]): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const s of slots) if (s.type === "custom") out[s.col.name] = s.members.map((m) => `${m.projectId}:${m.columnId}`);
		return out;
	}

	it("no project at all yields no lanes", () => {
		expect(getBoardColumns([])).toEqual([]);
	});

	it("two default boards produce exactly one set of built-in lanes", () => {
		expect(tokens(getBoardColumns([p("a"), p("b")]))).toEqual([
			"todo",
			"in-progress",
			"user-questions",
			"review-by-ai",
			"review-by-user",
			"review-by-colleague",
			"completed",
			"cancelled",
		]);
	});

	it("same-named custom columns merge into one lane carrying both projects' column ids", () => {
		const slots = getBoardColumns([
			p("a", { customColumns: [customCol("a-hold", "On hold")] }),
			p("b", { customColumns: [customCol("b-hold", "On hold")] }),
		]);
		expect(tokens(slots).filter((token) => token.startsWith("custom:"))).toEqual(["custom:a-hold"]);
		expect(laneMembers(slots)).toEqual({ "On hold": ["a:a-hold", "b:b-hold"] });
	});

	it("the merge is case- and whitespace-insensitive", () => {
		const slots = getBoardColumns([
			p("a", { customColumns: [customCol("a-hold", "On hold")] }),
			p("b", { customColumns: [customCol("b-hold", "  ON   HOLD ")] }),
		]);
		expect(laneMembers(slots)).toEqual({ "On hold": ["a:a-hold", "b:b-hold"] });
	});

	it("differently-named custom columns stay separate lanes", () => {
		const slots = getBoardColumns([
			p("a", { customColumns: [customCol("a-hold", "On hold")] }),
			p("b", { customColumns: [customCol("b-deploy", "Deploy")] }),
		]);
		expect(tokens(slots).filter((token) => token.startsWith("custom:"))).toEqual(["custom:a-hold", "custom:b-deploy"]);
	});

	it("a built-in lane hidden in one project still shows when another project shows it", () => {
		const slots = tokens(getBoardColumns([p("a", { peerReviewEnabled: false }), p("b")]));
		expect(slots).toContain("review-by-colleague");
	});

	it("a built-in lane hidden in every project stays hidden", () => {
		const slots = tokens(getBoardColumns([p("a", { peerReviewEnabled: false }), p("b", { peerReviewEnabled: false })]));
		expect(slots).not.toContain("review-by-colleague");
	});

	it("a later project's unseen lane lands after its own predecessor, not at the end", () => {
		const slots = tokens(
			getBoardColumns([
				p("a"),
				p("b", { customColumns: [customCol("b-triage", "Triage")], columnOrder: ["todo", "b-triage", "in-progress"] }),
			]),
		);
		expect(slots.slice(0, 3)).toEqual(["todo", "custom:b-triage", "in-progress"]);
	});

	it("built-in lanes accept a card from any project; a merged lane only from its members", () => {
		const slots = getBoardColumns([
			p("a", { customColumns: [customCol("a-hold", "On hold")] }),
			p("b", { customColumns: [customCol("b-deploy", "Deploy")] }),
		]);
		const todo = slots.find((s) => s.type === "builtin" && s.status === "todo")!;
		const hold = slots.find((s) => s.type === "custom" && s.col.id === "a-hold")!;
		expect(laneAcceptsProject(todo, "b")).toBe(true);
		expect(laneAcceptsProject(hold, "a")).toBe(true);
		expect(laneAcceptsProject(hold, "b")).toBe(false);
	});

	it("a drop writes the custom-column id of the dropped card's OWN project", () => {
		const slots = getBoardColumns([
			p("a", { customColumns: [customCol("a-hold", "On hold")] }),
			p("b", { customColumns: [customCol("b-hold", "On hold")] }),
		]);
		const hold = slots.find((s) => s.type === "custom")!;
		expect(laneColumnIdForProject(hold, "a")).toBe("a-hold");
		expect(laneColumnIdForProject(hold, "b")).toBe("b-hold");
		expect(laneColumnIdForProject(hold, "c")).toBeNull();
	});

	it("a built-in lane has no custom-column id to write", () => {
		const [todo] = getBoardColumns([p("a")]);
		expect(laneColumnIdForProject(todo, "a")).toBeNull();
	});
});
