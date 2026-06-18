import { describe, expect, it } from "vitest";
import { fuzzyRank, fuzzyScore } from "../fuzzyMatch";

describe("fuzzyScore", () => {
	it("matches an empty query against anything with score 0", () => {
		const r = fuzzyScore("", "Users");
		expect(r.matched).toBe(true);
		expect(r.score).toBe(0);
		expect(r.indices).toEqual([]);
	});

	it("does not match when query is not a subsequence", () => {
		expect(fuzzyScore("xyz", "Users").matched).toBe(false);
	});

	it("does not match against an empty target", () => {
		expect(fuzzyScore("a", "").matched).toBe(false);
	});

	it("matches a case-insensitive prefix and records indices", () => {
		const r = fuzzyScore("use", "Users");
		expect(r.matched).toBe(true);
		expect(r.indices).toEqual([0, 1, 2]);
	});

	it("matches a scattered subsequence", () => {
		// "Users" → U(0) s(1) e(2) r(3) s(4); "ur" lands on indices 0 and 3.
		const r = fuzzyScore("ur", "Users");
		expect(r.matched).toBe(true);
		expect(r.indices).toEqual([0, 3]);
	});

	it("scores a prefix match higher than a scattered one", () => {
		const prefix = fuzzyScore("use", "Users").score;
		const scattered = fuzzyScore("urs", "Users").score;
		expect(prefix).toBeGreaterThan(scattered);
	});

	it("rewards word-boundary matches (separators)", () => {
		// "ws" hits the start of both words in "web service".
		const r = fuzzyScore("ws", "web service");
		expect(r.matched).toBe(true);
		expect(r.indices).toEqual([0, 4]);
	});

	it("gives an exact full-string match the highest score", () => {
		const exact = fuzzyScore("users", "users").score;
		const partial = fuzzyScore("user", "users").score;
		expect(exact).toBeGreaterThan(partial);
	});
});

describe("fuzzyRank", () => {
	const projects = [
		{ id: "1", name: "users-service" },
		{ id: "2", name: "auth-users" },
		{ id: "3", name: "billing" },
	];
	const key = (p: { name: string }) => p.name;

	it("returns all items in original order for an empty query", () => {
		const ranked = fuzzyRank("", projects, key);
		expect(ranked.map((r) => r.item.id)).toEqual(["1", "2", "3"]);
	});

	it("drops non-matching items", () => {
		const ranked = fuzzyRank("users", projects, key);
		expect(ranked.map((r) => r.item.id).sort()).toEqual(["1", "2"]);
	});

	it("ranks the prefix match first", () => {
		const ranked = fuzzyRank("users", projects, key);
		expect(ranked[0].item.id).toBe("1"); // "users-service" starts with the query
	});

	it("returns an empty list when nothing matches", () => {
		expect(fuzzyRank("zzz", projects, key)).toEqual([]);
	});

	it("is stable for equal scores", () => {
		const same = [
			{ id: "a", name: "abc" },
			{ id: "b", name: "abc" },
		];
		const ranked = fuzzyRank("abc", same, (p) => p.name);
		expect(ranked.map((r) => r.item.id)).toEqual(["a", "b"]);
	});
});
