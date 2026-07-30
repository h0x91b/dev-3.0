import { getBoardColumns } from "../../shared/types";
import type { BoardColumnSlot, CustomColumn, Project } from "../../shared/types";

type ProjectInput = Parameters<typeof getBoardColumns>[0];

function customCol(id: string, name = id): CustomColumn {
	return { id, name, color: "#123456", llmInstruction: `move here for ${name}` };
}

/** Flatten slots to comparable tokens: builtin → status, custom → `custom:<id>`. */
function tokens(slots: BoardColumnSlot[]): string[] {
	return slots.map((s) => (s.type === "builtin" ? s.status : `custom:${s.col.id}`));
}

function project(overrides: Partial<Project> = {}): ProjectInput {
	return overrides as ProjectInput;
}

describe("getBoardColumns", () => {
	it("default git board (no columnOrder, no custom) — all built-ins in lifecycle order", () => {
		expect(tokens(getBoardColumns(project()))).toEqual([
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
		expect(tokens(getBoardColumns(project({ customColumns: cols })))).toEqual([
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
		const result = tokens(getBoardColumns(project({ peerReviewEnabled: false })));
		expect(result).not.toContain("review-by-colleague");
		expect(result).toContain("review-by-user");
	});

	it("AI Review hides when builtinColumnAgents is defined without a review-by-ai entry and empty", () => {
		const result = tokens(getBoardColumns(project({ builtinColumnAgents: {} })));
		expect(result).not.toContain("review-by-ai");
	});

	it("AI Review stays visible (even when disabled) if it currently has items", () => {
		const result = tokens(
			getBoardColumns(project({ builtinColumnAgents: {} }), { occupiedStatuses: new Set(["review-by-ai"] as const) }),
		);
		expect(result).toContain("review-by-ai");
	});

	// An occupied column that hides takes its cards off the board for good: they
	// stay in tasks.json and stay visible to the CLI, and a restart does not bring
	// them back. Never hide a column that holds tasks.
	it("PR Review stays visible with peer review off if it currently has items", () => {
		const result = tokens(
			getBoardColumns(project({ peerReviewEnabled: false }), {
				occupiedStatuses: new Set(["review-by-colleague"] as const),
			}),
		);
		expect(result).toContain("review-by-colleague");
	});

	it("virtual board keeps an occupied AI Review / PR Review column", () => {
		const result = tokens(
			getBoardColumns(project({ kind: "virtual" }), {
				occupiedStatuses: new Set(["review-by-ai", "review-by-colleague"] as const),
			}),
		);
		expect(result).toContain("review-by-ai");
		expect(result).toContain("review-by-colleague");
	});

	it("occupancy of an unrelated column does not resurrect a hidden one", () => {
		const result = tokens(
			getBoardColumns(project({ peerReviewEnabled: false }), { occupiedStatuses: new Set(["todo"] as const) }),
		);
		expect(result).not.toContain("review-by-colleague");
	});

	it("a hidden column stays hidden when it is listed in a stored columnOrder", () => {
		const result = tokens(
			getBoardColumns(project({ peerReviewEnabled: false, columnOrder: ["todo", "review-by-colleague", "completed"] })),
		);
		expect(result).not.toContain("review-by-colleague");
	});

	it("an occupied column listed in a stored columnOrder keeps its stored position", () => {
		const result = tokens(
			getBoardColumns(
				project({ peerReviewEnabled: false, columnOrder: ["todo", "review-by-colleague", "completed"] }),
				{ occupiedStatuses: new Set(["review-by-colleague"] as const) },
			),
		);
		expect(result.slice(0, 3)).toEqual(["todo", "review-by-colleague", "completed"]);
	});

	it("virtual (Operations) board hides both AI Review and PR Review", () => {
		const result = tokens(getBoardColumns(project({ kind: "virtual" })));
		expect(result).toEqual(["todo", "in-progress", "user-questions", "review-by-user", "completed", "cancelled"]);
	});

	it("respects an explicit columnOrder, placing custom columns where listed", () => {
		const cols = [customCol("deploy")];
		// columnOrder holds raw ids: built-in status strings + custom column ids.
		const result = tokens(
			getBoardColumns(project({ customColumns: cols, columnOrder: ["todo", "deploy", "in-progress"] })),
		);
		// Ordered head follows columnOrder; the rest are appended afterwards.
		expect(result.slice(0, 3)).toEqual(["todo", "custom:deploy", "in-progress"]);
		expect(result).toContain("user-questions");
		expect(result).toContain("completed");
	});

	it("re-inserts review-by-ai before review-by-user when absent from a stored columnOrder", () => {
		const result = tokens(getBoardColumns(project({ columnOrder: ["todo", "in-progress", "review-by-user"] })));
		const aiIdx = result.indexOf("review-by-ai");
		const userIdx = result.indexOf("review-by-user");
		expect(aiIdx).toBeGreaterThanOrEqual(0);
		expect(aiIdx).toBeLessThan(userIdx);
	});

	it("re-inserts review-by-colleague before completed when absent from a stored columnOrder", () => {
		const result = tokens(getBoardColumns(project({ columnOrder: ["todo", "completed"] })));
		const colleagueIdx = result.indexOf("review-by-colleague");
		const completedIdx = result.indexOf("completed");
		expect(colleagueIdx).toBeGreaterThanOrEqual(0);
		expect(colleagueIdx).toBeLessThan(completedIdx);
	});

	it("skips a columnOrder entry that references a non-existent custom column", () => {
		const result = tokens(getBoardColumns(project({ columnOrder: ["todo", "ghost-column", "in-progress"] })));
		expect(result).not.toContain("custom:ghost-column");
		expect(result).toContain("todo");
		expect(result).toContain("in-progress");
	});
});
