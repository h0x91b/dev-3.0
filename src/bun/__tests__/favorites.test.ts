import { describe, it, expect } from "vitest";
import type { FavoriteAgentConfig } from "../../shared/types";
import {
	MAX_FAVORITES,
	isFavorite,
	toggleFavorite,
	recordFavoriteUsage,
	orderFavorites,
	sanitizeFavorites,
} from "../../shared/favorites";

function fav(agentId: string, configId: string, uses = 0, lastUsedAt = 0): FavoriteAgentConfig {
	return { agentId, configId, uses, lastUsedAt };
}

describe("isFavorite", () => {
	const favs = [fav("claude", "sonnet"), fav("codex", "high")];
	it("matches on both agentId and configId", () => {
		expect(isFavorite(favs, "claude", "sonnet")).toBe(true);
		expect(isFavorite(favs, "codex", "high")).toBe(true);
	});
	it("is false when either half differs", () => {
		expect(isFavorite(favs, "claude", "high")).toBe(false);
		expect(isFavorite(favs, "gemini", "sonnet")).toBe(false);
		expect(isFavorite([], "claude", "sonnet")).toBe(false);
	});
});

describe("toggleFavorite — add / remove", () => {
	it("adds a new favorite with uses=0 and lastUsedAt=now", () => {
		const next = toggleFavorite([], "claude", "sonnet", 1000);
		expect(next).toEqual([fav("claude", "sonnet", 0, 1000)]);
	});
	it("appends new favorites in insertion order", () => {
		let favs = toggleFavorite([], "claude", "sonnet", 1000);
		favs = toggleFavorite(favs, "codex", "high", 2000);
		expect(favs.map((f) => f.configId)).toEqual(["sonnet", "high"]);
	});
	it("removes an existing favorite (toggle off)", () => {
		const favs = [fav("claude", "sonnet", 5, 100), fav("codex", "high", 2, 200)];
		const next = toggleFavorite(favs, "claude", "sonnet", 9999);
		expect(next).toEqual([fav("codex", "high", 2, 200)]);
	});
	it("does not mutate the input array", () => {
		const favs = [fav("claude", "sonnet")];
		const snapshot = JSON.parse(JSON.stringify(favs));
		toggleFavorite(favs, "codex", "high", 1);
		expect(favs).toEqual(snapshot);
	});
});

describe("toggleFavorite — eviction at MAX_FAVORITES", () => {
	// 10 favorites; uses ascending 1..10, lastUsedAt all distinct.
	function fullList(): FavoriteAgentConfig[] {
		return Array.from({ length: MAX_FAVORITES }, (_, i) =>
			fav("claude", `c${i}`, i + 1, (i + 1) * 100),
		);
	}

	it("evicts the lowest-uses existing entry, keeps the list at the cap", () => {
		const next = toggleFavorite(fullList(), "codex", "new", 9999);
		expect(next).toHaveLength(MAX_FAVORITES);
		expect(isFavorite(next, "codex", "new")).toBe(true);
		// c0 had the lowest uses (1) → evicted.
		expect(isFavorite(next, "claude", "c0")).toBe(false);
	});

	it("breaks uses ties by oldest lastUsedAt (LFU then LRU)", () => {
		const favs = [
			fav("a", "old", 1, 50), // lowest uses, oldest → victim
			fav("a", "new", 1, 500), // same uses, newer → survives
			...Array.from({ length: MAX_FAVORITES - 2 }, (_, i) => fav("a", `x${i}`, 5, (i + 1) * 10)),
		];
		const next = toggleFavorite(favs, "b", "added", 9999);
		expect(isFavorite(next, "a", "old")).toBe(false);
		expect(isFavorite(next, "a", "new")).toBe(true);
		expect(isFavorite(next, "b", "added")).toBe(true);
	});

	it("protects the just-added entry even when every existing entry has uses>0", () => {
		// All existing have uses >= 1; the new entry (uses=0) must NOT be the victim.
		const next = toggleFavorite(fullList(), "codex", "fresh", 9999);
		expect(isFavorite(next, "codex", "fresh")).toBe(true);
	});
});

describe("recordFavoriteUsage", () => {
	it("increments uses and updates lastUsedAt for a matching favorite", () => {
		const favs = [fav("claude", "sonnet", 3, 100), fav("codex", "high", 0, 50)];
		const next = recordFavoriteUsage(favs, "claude", "sonnet", 777);
		expect(next[0]).toEqual(fav("claude", "sonnet", 4, 777));
		expect(next[1]).toEqual(fav("codex", "high", 0, 50));
	});
	it("returns the same reference (no-op) when the pair is not a favorite", () => {
		const favs = [fav("claude", "sonnet", 3, 100)];
		expect(recordFavoriteUsage(favs, "codex", "high", 777)).toBe(favs);
	});
});

describe("orderFavorites", () => {
	it("orders by uses desc, ties by lastUsedAt desc, without mutating input", () => {
		const favs = [
			fav("a", "low", 1, 10),
			fav("a", "hi-old", 9, 10),
			fav("a", "hi-new", 9, 900),
			fav("a", "mid", 5, 50),
		];
		const ordered = orderFavorites(favs);
		expect(ordered.map((f) => f.configId)).toEqual(["hi-new", "hi-old", "mid", "low"]);
		// input untouched
		expect(favs[0].configId).toBe("low");
	});
});

describe("sanitizeFavorites", () => {
	it("returns undefined for non-arrays and empty arrays", () => {
		expect(sanitizeFavorites(undefined)).toBeUndefined();
		expect(sanitizeFavorites(null)).toBeUndefined();
		expect(sanitizeFavorites("nope")).toBeUndefined();
		expect(sanitizeFavorites([])).toBeUndefined();
	});
	it("keeps well-formed entries and drops malformed ones", () => {
		const raw = [
			{ agentId: "claude", configId: "sonnet", uses: 3, lastUsedAt: 100 },
			{ agentId: "codex", configId: "high" }, // missing counters → defaulted
			{ agentId: "", configId: "x", uses: 1, lastUsedAt: 1 }, // empty id → dropped
			{ configId: "y", uses: 1, lastUsedAt: 1 }, // no agentId → dropped
			42, // not an object → dropped
		];
		const out = sanitizeFavorites(raw)!;
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ agentId: "claude", configId: "sonnet", uses: 3, lastUsedAt: 100 });
		expect(out[1]).toEqual({ agentId: "codex", configId: "high", uses: 0, lastUsedAt: 0 });
	});
	it("caps the list at MAX_FAVORITES", () => {
		const raw = Array.from({ length: MAX_FAVORITES + 5 }, (_, i) => ({
			agentId: "a",
			configId: `c${i}`,
			uses: 0,
			lastUsedAt: 0,
		}));
		expect(sanitizeFavorites(raw)).toHaveLength(MAX_FAVORITES);
	});
});
