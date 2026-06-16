import { describe, it, expect } from "vitest";
import {
	bm25Score,
	claudeEncodePath,
	computeExclusionSet,
	countOccurrences,
	countTermFrequencies,
	countWords,
	idf,
	projectSlug,
	rankMatches,
	recencyMultiplier,
	reconstructWorktreePath,
	tokenizeQuery,
	RECENCY_MAX_MULTIPLIER,
	RECENCY_MIN_MULTIPLIER,
	type ConversationMatch,
} from "../../shared/conversation-search-core";

describe("claudeEncodePath", () => {
	it("replaces every slash and dot with a dash", () => {
		expect(claudeEncodePath("/Users/a/.dev3.0/worktrees/proj/e5065a6f/worktree")).toBe(
			"-Users-a--dev3-0-worktrees-proj-e5065a6f-worktree",
		);
	});
});

describe("reconstructWorktreePath", () => {
	it("builds the deterministic worktree path from short id", () => {
		expect(reconstructWorktreePath("/home/.dev3.0", "my-proj", "abcd1234-rest-of-uuid")).toBe(
			"/home/.dev3.0/worktrees/my-proj/abcd1234/worktree",
		);
	});
});

describe("projectSlug", () => {
	it("strips leading slash and replaces inner slashes, keeping dots", () => {
		expect(projectSlug("/Users/a/Desktop/dev-3.0")).toBe("Users-a-Desktop-dev-3.0");
	});
});

describe("tokenizeQuery", () => {
	it("lowercases, drops short tokens, and dedupes", () => {
		expect(tokenizeQuery("Frozen TIP a frozen rotation")).toEqual(["frozen", "tip", "rotation"]);
	});
	it("returns empty for whitespace-only", () => {
		expect(tokenizeQuery("  ")).toEqual([]);
	});
});

describe("countTermFrequencies (word boundary)", () => {
	it("counts whole words case-insensitively per token", () => {
		expect(countTermFrequencies("Tip tip TIP rotation", ["tip", "rotation"])).toEqual([3, 1]);
	});
	it("does not match inside larger words", () => {
		expect(countTermFrequencies("a tooltip and multiple tips", ["tip"])).toEqual([0]);
	});
});

describe("countOccurrences", () => {
	it("sums per-term counts", () => {
		expect(countOccurrences("frozen rotation frozen", ["frozen", "rotation"])).toBe(3);
	});
});

describe("countWords", () => {
	it("counts word tokens", () => {
		expect(countWords("hello world, foo_bar 123")).toBe(4);
	});
	it("returns 0 for empty text", () => {
		expect(countWords("")).toBe(0);
	});
});

describe("idf", () => {
	it("gives rare terms higher weight than common ones", () => {
		const rare = idf(1, 100);
		const common = idf(95, 100);
		expect(rare).toBeGreaterThan(common);
	});
	it("stays non-negative even when a term is in every document", () => {
		expect(idf(100, 100)).toBeGreaterThanOrEqual(0);
	});
});

describe("bm25Score", () => {
	it("returns 0 when no term matched", () => {
		expect(bm25Score([0, 0], [1, 1], 50, 50)).toBe(0);
	});
	it("saturates with term frequency (diminishing returns)", () => {
		const gain1 = bm25Score([1], [1], 50, 50) - bm25Score([0], [1], 50, 50);
		const gain10to11 = bm25Score([11], [1], 50, 50) - bm25Score([10], [1], 50, 50);
		expect(gain10to11).toBeLessThan(gain1);
	});
	it("penalizes longer documents for the same term frequency", () => {
		const short = bm25Score([3], [1], 10, 50);
		const long = bm25Score([3], [1], 200, 50);
		expect(short).toBeGreaterThan(long);
	});
	it("weights a rare term above a common one at equal frequency", () => {
		const rare = bm25Score([2], [idf(1, 100)], 50, 50);
		const common = bm25Score([2], [idf(90, 100)], 50, 50);
		expect(rare).toBeGreaterThan(common);
	});
});

describe("computeExclusionSet", () => {
	const tasks = [
		{ id: "self", groupId: "g1" },
		{ id: "sib1", groupId: "g1" },
		{ id: "sib2", groupId: "g1" },
		{ id: "other", groupId: "g2" },
		{ id: "solo", groupId: null },
	];
	it("excludes self and all same-group siblings", () => {
		const ex = computeExclusionSet("self", "g1", tasks);
		expect([...ex].sort()).toEqual(["self", "sib1", "sib2"]);
	});
	it("excludes only self when group is null", () => {
		const ex = computeExclusionSet("solo", null, tasks);
		expect([...ex]).toEqual(["solo"]);
	});
	it("excludes nothing when there is no current task", () => {
		expect(computeExclusionSet(null, null, tasks).size).toBe(0);
	});
});

describe("recencyMultiplier", () => {
	it("is highest for fresh activity and decays with age", () => {
		const fresh = recencyMultiplier(0, 0);
		const old = recencyMultiplier(1000 * 24 * 60 * 60 * 1000, 0);
		expect(fresh).toBeCloseTo(RECENCY_MAX_MULTIPLIER, 5);
		expect(old).toBeGreaterThanOrEqual(RECENCY_MIN_MULTIPLIER);
		expect(old).toBeLessThan(fresh);
	});
});

describe("rankMatches", () => {
	const mk = (id: string, score: number, lastActivityMs: number | null): ConversationMatch => ({
		taskId: id,
		title: id,
		status: "completed",
		agentId: null,
		score,
		bodyMatches: 1,
		metaMatches: 0,
		snippets: [],
		transcriptPaths: [],
		lastActivityMs,
	});
	it("sorts by score desc, drops zero-score, and applies the limit", () => {
		const ranked = rankMatches([mk("a", 5, 1), mk("b", 10, 1), mk("zero", 0, 1), mk("c", 1, 1)], 2);
		expect(ranked.map((m) => m.taskId)).toEqual(["b", "a"]);
	});
	it("breaks score ties by recency", () => {
		const ranked = rankMatches([mk("old", 5, 100), mk("new", 5, 999)], 5);
		expect(ranked.map((m) => m.taskId)).toEqual(["new", "old"]);
	});
});
