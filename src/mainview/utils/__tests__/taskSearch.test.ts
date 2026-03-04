import type { Task } from "../../../shared/types";
import { matchesSearchQuery } from "../taskSearch";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		seq: 42,
		projectId: "proj-1",
		title: "Fix authentication bug",
		description: "The login flow breaks when session expires",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("matchesSearchQuery", () => {
	// ---- Empty / whitespace query ----

	it("returns true for empty query", () => {
		expect(matchesSearchQuery(makeTask(), "")).toBe(true);
	});

	it("returns true for whitespace-only query", () => {
		expect(matchesSearchQuery(makeTask(), "   ")).toBe(true);
	});

	// ---- Title matching ----

	it("matches by title substring (case-insensitive)", () => {
		expect(matchesSearchQuery(makeTask({ title: "Fix auth bug" }), "auth")).toBe(true);
	});

	it("matches by title with different case", () => {
		expect(matchesSearchQuery(makeTask({ title: "Fix Auth Bug" }), "fix auth")).toBe(true);
	});

	it("does not match unrelated title", () => {
		expect(matchesSearchQuery(makeTask({ title: "Refactor database" }), "auth")).toBe(false);
	});

	// ---- Description matching ----

	it("matches by description substring", () => {
		expect(
			matchesSearchQuery(
				makeTask({ description: "The login flow breaks when session expires" }),
				"session",
			),
		).toBe(true);
	});

	it("matches description case-insensitively", () => {
		expect(
			matchesSearchQuery(
				makeTask({ description: "CRITICAL ERROR in production" }),
				"critical error",
			),
		).toBe(true);
	});

	it("does not match unrelated description", () => {
		expect(
			matchesSearchQuery(
				makeTask({ title: "Unrelated title", description: "Improve performance of data loader" }),
				"auth",
			),
		).toBe(false);
	});

	// ---- Seq (numeric human-readable ID) matching ----

	it("matches by exact seq number", () => {
		expect(matchesSearchQuery(makeTask({ seq: 190 }), "190")).toBe(true);
	});

	it("matches by seq number with # prefix", () => {
		expect(matchesSearchQuery(makeTask({ seq: 190 }), "#190")).toBe(true);
	});

	it("matches by seq number prefix (partial)", () => {
		expect(matchesSearchQuery(makeTask({ seq: 190 }), "19")).toBe(true);
	});

	it("does not match different seq number", () => {
		expect(matchesSearchQuery(makeTask({ seq: 42 }), "99")).toBe(false);
	});

	it("matches seq=1 when query is '1' and not confuse with unrelated numbers", () => {
		expect(matchesSearchQuery(makeTask({ seq: 1, title: "No numbers here", description: "" }), "1")).toBe(true);
	});

	// ---- Full UUID (long ID) matching ----

	it("matches by full UUID", () => {
		const id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		expect(matchesSearchQuery(makeTask({ id }), id)).toBe(true);
	});

	it("matches by UUID prefix", () => {
		expect(
			matchesSearchQuery(
				makeTask({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
				"a1b2c3d4-e5f6",
			),
		).toBe(true);
	});

	it("matches UUID case-insensitively", () => {
		expect(
			matchesSearchQuery(
				makeTask({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
				"A1B2C3D4",
			),
		).toBe(true);
	});

	// ---- Short ID (first 8 chars of UUID) matching ----

	it("matches by short ID (first 8 chars of UUID)", () => {
		expect(
			matchesSearchQuery(
				makeTask({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }),
				"a1b2c3d4",
			),
		).toBe(true);
	});

	it("matches by partial short ID", () => {
		expect(
			matchesSearchQuery(
				makeTask({ id: "e1052f7e-4081-4739-946f-aa1c93292996" }),
				"e1052",
			),
		).toBe(true);
	});

	it("does not match unrelated short ID", () => {
		expect(
			matchesSearchQuery(
				makeTask({
					id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
					title: "No match",
					description: "Nothing here",
					seq: 1,
				}),
				"zzzzzzz",
			),
		).toBe(false);
	});

	// ---- Combined scenarios ----

	it("matches title even when other fields do not match", () => {
		expect(
			matchesSearchQuery(
				makeTask({
					id: "00000000-0000-0000-0000-000000000000",
					seq: 1,
					title: "Special feature",
					description: "Nothing relevant",
				}),
				"special",
			),
		).toBe(true);
	});

	it("matches description even when title does not match", () => {
		expect(
			matchesSearchQuery(
				makeTask({
					title: "Unrelated title",
					description: "Contains the magic keyword",
				}),
				"magic",
			),
		).toBe(true);
	});

	it("matches seq even when title and description do not match", () => {
		expect(
			matchesSearchQuery(
				makeTask({
					seq: 777,
					title: "No numbers",
					description: "Still no numbers",
				}),
				"777",
			),
		).toBe(true);
	});

	it("matches ID even when title, description, and seq do not match", () => {
		expect(
			matchesSearchQuery(
				makeTask({
					id: "deadbeef-1234-5678-9abc-def012345678",
					seq: 1,
					title: "No match",
					description: "No match either",
				}),
				"deadbeef",
			),
		).toBe(true);
	});

	// ---- Edge cases ----

	it("handles query with leading/trailing spaces", () => {
		expect(matchesSearchQuery(makeTask({ title: "Fix bug" }), "  fix  ")).toBe(true);
	});

	it("handles task with empty title and description", () => {
		expect(
			matchesSearchQuery(
				makeTask({ title: "", description: "", seq: 5 }),
				"5",
			),
		).toBe(true);
	});

	it("handles task with empty title and description — no match", () => {
		expect(
			matchesSearchQuery(
				makeTask({
					id: "00000000-0000-0000-0000-000000000000",
					title: "",
					description: "",
					seq: 5,
				}),
				"xyz",
			),
		).toBe(false);
	});
});
