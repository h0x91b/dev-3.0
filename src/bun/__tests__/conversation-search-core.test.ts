import { describe, it, expect } from "vitest";
import {
	bm25Score,
	claudeEncodePath,
	findClaudeStoreName,
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
	it("turns slashes, dots and every other non-alphanumeric character into a dash, as Claude Code does", () => {
		expect(claudeEncodePath("/Users/a/.dev3.0/worktrees/proj/e5065a6f/worktree")).toBe(
			"-Users-a--dev3-0-worktrees-proj-e5065a6f-worktree",
		);
		expect(claudeEncodePath("/var/folders/5qkl_yy/T/my repo,v2")).toBe("-var-folders-5qkl-yy-T-my-repo-v2");
		expect(claudeEncodePath("C:\\Users\\a\\repo")).toBe("C--Users-a-repo");
		// A name over 200 characters is cut and gets Claude Code's path hash (a real store name on disk).
		const path = "/private/var/folders/yg/5qkl_yy11t92kql23hk52t9w0000gp/T/dev3-qa/2ac1b9695631/seeded/home/.dev3.0/worktrees/var-folders-yg-5qkl_yy11t92kql23hk52t9w0000gp-T-dev3-qa-2ac1b9695631-seeded-fixture-repo/c9aa4f3a/worktree";
		expect(claudeEncodePath(path)).toBe(
			"-private-var-folders-yg-5qkl-yy11t92kql23hk52t9w0000gp-T-dev3-qa-2ac1b9695631-seeded-home--dev3-0-worktrees-var-folders-yg-5qkl-yy11t92kql23hk52t9w0000gp-T-dev3-qa-2ac1b9695631-seeded-fixture-repo-c9a-sw8x6g",
		);
	});
});

describe("findClaudeStoreName", () => {
	const long = `/w/${"a".repeat(220)}`;

	it("prefers the exact store name, else a unique cut store by its 200-character prefix", () => {
		expect(findClaudeStoreName(["-w-repo", "-w-repo-sub"], "/w/repo")).toBe("-w-repo");
		expect(findClaudeStoreName(["-w-repo-sub"], "/w/repo")).toBeNull();
		const cut = claudeEncodePath(long).slice(0, 200);
		expect(findClaudeStoreName([`${cut}-otherhash`], long)).toBe(`${cut}-otherhash`);
		expect(findClaudeStoreName([`${cut}-one`, `${cut}-two`], long)).toBeNull();
	});
});

describe("reconstructWorktreePath", () => {
	it("builds the deterministic worktree path from short id, following the task's in-project stamp over the project setting", () => {
		expect(reconstructWorktreePath("/home/.dev3.0", { path: "/my-proj" }, { id: "abcd1234-rest-of-uuid" })).toBe(
			"/home/.dev3.0/worktrees/my-proj/abcd1234/worktree",
		);
		const task = { id: "abcd1234-rest-of-uuid", taskDirLocation: "project" as const };
		expect(reconstructWorktreePath("/home/.dev3.0", { path: "/r/my-proj" }, task)).toBe(
			"/r/my-proj/.dev3/worktrees/abcd1234/worktree",
		);
		expect(reconstructWorktreePath("/home/.dev3.0", { path: "/r/my-proj", storageRoot: "project" }, { id: task.id })).toBe(
			"/home/.dev3.0/worktrees/r-my-proj/abcd1234/worktree",
		);
		// projectSlug strips the leading slash and replaces inner slashes, keeping dots.
		expect(projectSlug("/Users/a/Desktop/dev-3.0")).toBe("Users-a-Desktop-dev-3.0");
	});
});

describe("tokenizing and counting", () => {
	it("tokenizes queries and counts whole words case-insensitively, never inside larger words", () => {
		expect(tokenizeQuery("Frozen TIP a frozen rotation")).toEqual(["frozen", "tip", "rotation"]);
		expect(tokenizeQuery("  ")).toEqual([]);
		expect(countTermFrequencies("Tip tip TIP rotation", ["tip", "rotation"])).toEqual([3, 1]);
		expect(countTermFrequencies("a tooltip and multiple tips", ["tip"])).toEqual([0]);
		expect(countOccurrences("frozen rotation frozen", ["frozen", "rotation"])).toBe(3);
		expect(countWords("hello world, foo_bar 123")).toBe(4);
		expect(countWords("")).toBe(0);
	});
});

describe("idf / bm25Score", () => {
	it("weights rare terms higher, scores 0 on no match, saturates with frequency and penalizes long documents", () => {
		expect(idf(1, 100)).toBeGreaterThan(idf(95, 100));
		// stays non-negative even when a term is in every document
		expect(idf(100, 100)).toBeGreaterThanOrEqual(0);
		expect(bm25Score([0, 0], [1, 1], 50, 50)).toBe(0);
		const gain1 = bm25Score([1], [1], 50, 50) - bm25Score([0], [1], 50, 50);
		const gain10to11 = bm25Score([11], [1], 50, 50) - bm25Score([10], [1], 50, 50);
		expect(gain10to11).toBeLessThan(gain1);
		const short = bm25Score([3], [1], 10, 50);
		const long = bm25Score([3], [1], 200, 50);
		expect(short).toBeGreaterThan(long);
		// a rare term outweighs a common one at equal frequency
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
	it("excludes self and same-group siblings, only self without a group, nothing without a task", () => {
		expect([...computeExclusionSet("self", "g1", tasks)].sort()).toEqual(["self", "sib1", "sib2"]);
		expect([...computeExclusionSet("solo", null, tasks)]).toEqual(["solo"]);
		expect(computeExclusionSet(null, null, tasks).size).toBe(0);
	});
});

describe("recencyMultiplier / rankMatches", () => {
	it("recency is highest for fresh activity and decays with age", () => {
		const fresh = recencyMultiplier(0, 0);
		const old = recencyMultiplier(1000 * 24 * 60 * 60 * 1000, 0);
		expect(fresh).toBeCloseTo(RECENCY_MAX_MULTIPLIER, 5);
		expect(old).toBeGreaterThanOrEqual(RECENCY_MIN_MULTIPLIER);
		expect(old).toBeLessThan(fresh);
	});

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
		// score ties break by recency
		expect(rankMatches([mk("old", 5, 100), mk("new", 5, 999)], 5).map((m) => m.taskId)).toEqual(["new", "old"]);
	});
});
