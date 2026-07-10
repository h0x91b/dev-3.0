import type { Task } from "../../../shared/types";
import type { TaskQueryContext } from "../taskSearch";
import {
	parseTaskQuery,
	matchesTaskQuery,
	toggleFacetToken,
	isFacetTokenActive,
	countActiveFacetTokens,
	facetToken,
} from "../taskSearch";

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

/** Build a facet context; every facet empty unless overridden. */
function ctx(overrides: Partial<TaskQueryContext> = {}): TaskQueryContext {
	return {
		labelNames: [],
		agentName: null,
		statusValues: [],
		priorityValue: "",
		hasPort: false,
		isAttention: false,
		prNumber: null,
		...overrides,
	};
}

describe("matchesTaskQuery — free text (fuzzy/identifier, unchanged behavior)", () => {
	it("returns true for empty query", () => {
		expect(matchesTaskQuery(makeTask(), "", ctx())).toBe(true);
	});

	it("returns true for whitespace-only query", () => {
		expect(matchesTaskQuery(makeTask(), "   ", ctx())).toBe(true);
	});

	it("matches by title substring (case-insensitive)", () => {
		expect(matchesTaskQuery(makeTask({ title: "Fix auth bug" }), "auth", ctx())).toBe(true);
	});

	it("matches title by fuzzy subsequence (non-contiguous)", () => {
		expect(matchesTaskQuery(makeTask({ title: "Fix authentication bug" }), "fxbug", ctx())).toBe(true);
	});

	it("does not match unrelated title/description", () => {
		expect(
			matchesTaskQuery(makeTask({ title: "Refactor database", description: "" }), "xyzq", ctx()),
		).toBe(false);
	});

	it("matches by description substring", () => {
		expect(
			matchesTaskQuery(
				makeTask({ description: "The login flow breaks when session expires" }),
				"session",
				ctx(),
			),
		).toBe(true);
	});

	it("matches by seq prefix and with # prefix", () => {
		expect(matchesTaskQuery(makeTask({ seq: 190 }), "19", ctx())).toBe(true);
		expect(matchesTaskQuery(makeTask({ seq: 190 }), "#190", ctx())).toBe(true);
	});

	it("matches by UUID prefix (case-insensitive)", () => {
		expect(
			matchesTaskQuery(makeTask({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }), "A1B2C3D4", ctx()),
		).toBe(true);
	});

	it("matches PR number from context (with and without pr prefix)", () => {
		expect(matchesTaskQuery(makeTask(), "456", ctx({ prNumber: 456 }))).toBe(true);
		expect(matchesTaskQuery(makeTask(), "pr789", ctx({ prNumber: 789 }))).toBe(true);
	});

	it("does not match PR number when context prNumber is null", () => {
		expect(
			matchesTaskQuery(
				makeTask({ title: "No match", description: "No match", seq: 1, id: "00000000-0000-0000-0000-000000000000" }),
				"pr123",
				ctx({ prNumber: null }),
			),
		).toBe(false);
	});
});

describe("parseTaskQuery", () => {
	it("parses a bare facet value", () => {
		expect(parseTaskQuery("label:Feature").facets.label).toEqual(["feature"]);
	});

	it("parses a quoted multi-word value", () => {
		expect(parseTaskQuery('label:"Bug Fix"').facets.label).toEqual(["bug fix"]);
	});

	it("separates recognized facets from free text", () => {
		const parsed = parseTaskQuery('login label:"Bug Fix" agent:Codex');
		expect(parsed.facets.label).toEqual(["bug fix"]);
		expect(parsed.facets.agent).toEqual(["codex"]);
		expect(parsed.freeText).toBe("login");
	});

	it("treats an unrecognized key:value as free text", () => {
		const parsed = parseTaskQuery("foo:bar login");
		expect(parsed.facets.label).toEqual([]);
		expect(parsed.freeText).toBe("foo:bar login");
	});

	it("recognizes only enumerated flag values; unknown flag value falls to free text", () => {
		expect(parseTaskQuery("is:attention").facets.is).toEqual(["attention"]);
		expect(parseTaskQuery("has:port").facets.has).toEqual(["port"]);
		const bogus = parseTaskQuery("is:banana");
		expect(bogus.facets.is).toEqual([]);
		expect(bogus.freeText).toBe("is:banana");
	});

	it("collects multiple values of the same facet", () => {
		expect(parseTaskQuery("label:Bug label:Feature").facets.label).toEqual(["bug", "feature"]);
	});

	it("is case-insensitive on the facet key", () => {
		expect(parseTaskQuery("STATUS:review").facets.status).toEqual(["review"]);
	});
});

describe("matchesTaskQuery — facets", () => {
	it("matches a label by case-insensitive substring", () => {
		expect(matchesTaskQuery(makeTask(), "label:bug", ctx({ labelNames: ["Bug Fix"] }))).toBe(true);
		expect(matchesTaskQuery(makeTask(), 'label:"bug fix"', ctx({ labelNames: ["Bug Fix"] }))).toBe(true);
	});

	it("matches an agent by substring", () => {
		expect(matchesTaskQuery(makeTask(), "agent:cod", ctx({ agentName: "Codex" }))).toBe(true);
		expect(matchesTaskQuery(makeTask(), "agent:codex", ctx({ agentName: "Claude" }))).toBe(false);
	});

	it("matches status by id, localized label, or custom-column name (substring)", () => {
		const statusCtx = ctx({ statusValues: ["review-by-user", "Your Review"] });
		expect(matchesTaskQuery(makeTask(), "status:review", statusCtx)).toBe(true);
		expect(matchesTaskQuery(makeTask(), 'status:"your review"', statusCtx)).toBe(true);
		expect(matchesTaskQuery(makeTask(), "status:done", statusCtx)).toBe(false);
		const parkedCtx = ctx({ statusValues: ["On Hold", "review-by-user", "Your Review"] });
		expect(matchesTaskQuery(makeTask(), 'status:"on hold"', parkedCtx)).toBe(true);
	});

	it("is:attention matches only when the context flag is set", () => {
		expect(matchesTaskQuery(makeTask(), "is:attention", ctx({ isAttention: true }))).toBe(true);
		expect(matchesTaskQuery(makeTask(), "is:attention", ctx({ isAttention: false }))).toBe(false);
	});

	it("has:port matches only when the context flag is set", () => {
		expect(matchesTaskQuery(makeTask(), "has:port", ctx({ hasPort: true }))).toBe(true);
		expect(matchesTaskQuery(makeTask(), "has:port", ctx({ hasPort: false }))).toBe(false);
	});

	it("priority matches the task's effective level (case-insensitive)", () => {
		expect(matchesTaskQuery(makeTask(), "priority:P0", ctx({ priorityValue: "p0" }))).toBe(true);
		expect(matchesTaskQuery(makeTask(), "priority:p0", ctx({ priorityValue: "p0" }))).toBe(true);
		expect(matchesTaskQuery(makeTask(), "priority:P0", ctx({ priorityValue: "p2" }))).toBe(false);
	});

	it("ORs within the priority facet (multi-select)", () => {
		expect(matchesTaskQuery(makeTask(), "priority:P0 priority:P1", ctx({ priorityValue: "p1" }))).toBe(true);
	});

	it("ANDs across facets", () => {
		const c = ctx({ agentName: "Codex", labelNames: ["Bug"] });
		expect(matchesTaskQuery(makeTask(), "agent:Codex label:Bug", c)).toBe(true);
		expect(matchesTaskQuery(makeTask(), "agent:Codex label:Feature", c)).toBe(false);
	});

	it("ORs within a facet", () => {
		const c = ctx({ labelNames: ["Feature"] });
		expect(matchesTaskQuery(makeTask(), "label:Bug label:Feature", c)).toBe(true);
	});

	it("combines free text with facets (AND)", () => {
		const c = ctx({ labelNames: ["Bug"] });
		expect(matchesTaskQuery(makeTask({ title: "Fix login" }), "login label:Bug", c)).toBe(true);
		expect(matchesTaskQuery(makeTask({ title: "Fix logout", description: "" }), "signup label:Bug", c)).toBe(false);
	});

	it("a recognized facet value that matches nothing yields no result", () => {
		expect(matchesTaskQuery(makeTask(), "label:nonexistent", ctx({ labelNames: ["Bug"] }))).toBe(false);
	});
});

describe("isFacetTokenActive — exact (checked-state) vs substring (filter)", () => {
	it("is true on exact token presence", () => {
		expect(isFacetTokenActive("agent:Codex", "agent", "Codex")).toBe(true);
	});

	it("is case-insensitive on the value", () => {
		expect(isFacetTokenActive("agent:codex", "agent", "Codex")).toBe(true);
	});

	it("matches quoted and bare forms of the same value", () => {
		expect(isFacetTokenActive('label:"Bug"', "label", "Bug")).toBe(true);
		expect(isFacetTokenActive("label:Bug", "label", "Bug")).toBe(true);
	});

	it("is NOT a substring match (checked ≠ filter)", () => {
		// `label:bug` filters "Bug Fix" but the "Bug Fix" checkbox is not checked.
		expect(isFacetTokenActive("label:bug", "label", "Bug Fix")).toBe(false);
	});

	it("does not match a value that is a prefix of a longer token", () => {
		expect(isFacetTokenActive("agent:Codex", "agent", "Cod")).toBe(false);
	});
});

describe("toggleFacetToken", () => {
	it("appends a bare token to an empty query", () => {
		expect(toggleFacetToken("", "agent", "Codex")).toBe("agent:Codex");
	});

	it("auto-quotes a value containing a space", () => {
		expect(toggleFacetToken("", "label", "Bug Fix")).toBe('label:"Bug Fix"');
	});

	it("appends to an existing query preserving prior text", () => {
		expect(toggleFacetToken("login", "label", "Bug")).toBe("login label:Bug");
	});

	it("removes the token when already present (bare)", () => {
		expect(toggleFacetToken("login agent:Codex", "agent", "Codex")).toBe("login");
	});

	it("removes the token when already present (quoted)", () => {
		expect(toggleFacetToken('login label:"Bug Fix"', "label", "Bug Fix")).toBe("login");
	});

	it("round-trips: add then remove returns to the original", () => {
		const added = toggleFacetToken("login", "status", "review");
		expect(added).toBe("login status:review");
		expect(toggleFacetToken(added, "status", "review")).toBe("login");
	});
});

describe("values containing double quotes / backslashes (DSL escaping)", () => {
	// Labels, agent names and custom-column names are free-form user strings and
	// may legally contain the DSL's own delimiter. facetToken must escape it and
	// the parser must round-trip it — otherwise the matching task disappears.
	const QUOTED = 'He said "ship it"';
	const BACKSLASH = "path\\to\\thing";

	it("facetToken output round-trips through the parser (embedded quotes)", () => {
		const token = facetToken("label", QUOTED);
		expect(parseTaskQuery(token).facets.label).toEqual([QUOTED.toLowerCase()]);
	});

	it("facetToken output round-trips through the parser (backslashes)", () => {
		const token = facetToken("label", BACKSLASH);
		expect(parseTaskQuery(token).facets.label).toEqual([BACKSLASH.toLowerCase()]);
	});

	it("a task whose label contains a quote still matches its own token", () => {
		const token = facetToken("label", QUOTED);
		expect(matchesTaskQuery(makeTask(), token, ctx({ labelNames: [QUOTED] }))).toBe(true);
	});

	it("isFacetTokenActive recognizes the serialized quoted token", () => {
		const token = facetToken("label", QUOTED);
		expect(isFacetTokenActive(token, "label", QUOTED)).toBe(true);
	});

	it("toggleFacetToken round-trips a quote-bearing value (add then remove)", () => {
		const added = toggleFacetToken("login", "label", QUOTED);
		expect(matchesTaskQuery(makeTask({ title: "login" }), added, ctx({ labelNames: [QUOTED] }))).toBe(true);
		expect(toggleFacetToken(added, "label", QUOTED)).toBe("login");
	});

	it("counts a quote-bearing facet token exactly once", () => {
		expect(countActiveFacetTokens(facetToken("label", QUOTED))).toBe(1);
	});
});

describe("countActiveFacetTokens", () => {
	it("counts every recognized facet token", () => {
		expect(countActiveFacetTokens('label:"Bug Fix" agent:Codex is:attention login')).toBe(3);
	});

	it("counts duplicate-facet tokens separately", () => {
		expect(countActiveFacetTokens("label:Bug label:Feature")).toBe(2);
	});

	it("ignores free text and unrecognized tokens", () => {
		expect(countActiveFacetTokens("login foo:bar")).toBe(0);
	});
});
