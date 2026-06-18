// Lightweight fuzzy matcher used by the project quick-switch palette (Cmd/Ctrl+K).
// Case-insensitive subsequence match with fzf-style scoring so the "most relevant"
// project sorts first: prefix and word-boundary matches beat scattered ones, and
// consecutive runs beat gappy ones.

export interface FuzzyMatch {
	/** True if every query char was found in order. */
	matched: boolean;
	/** Higher is better. 0 for an empty query (caller keeps original order). */
	score: number;
	/** Indices in the target that matched, for highlighting. */
	indices: number[];
}

export interface FuzzyResult<T> {
	item: T;
	score: number;
	indices: number[];
}

const SEPARATORS = new Set([" ", "-", "_", "/", ".", "\\"]);

function isBoundary(target: string, index: number): boolean {
	if (index === 0) return true;
	if (SEPARATORS.has(target[index - 1])) return true;
	// camelCase boundary: lowercase/digit followed by uppercase.
	const prev = target[index - 1];
	const cur = target[index];
	return prev === prev.toLowerCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * Score `query` against `target`. Returns `matched: false` when the query is not
 * a subsequence of the target. An empty query always matches with score 0.
 */
export function fuzzyScore(query: string, target: string): FuzzyMatch {
	const q = query.trim();
	if (q.length === 0) return { matched: true, score: 0, indices: [] };
	if (target.length === 0) return { matched: false, score: 0, indices: [] };

	const lowerQuery = q.toLowerCase();
	const lowerTarget = target.toLowerCase();

	const indices: number[] = [];
	let score = 0;
	let prevMatchIndex = -1;
	let ti = 0;

	for (let qi = 0; qi < lowerQuery.length; qi++) {
		const qc = lowerQuery[qi];
		let found = -1;
		for (; ti < lowerTarget.length; ti++) {
			if (lowerTarget[ti] === qc) {
				found = ti;
				ti++;
				break;
			}
		}
		if (found === -1) return { matched: false, score: 0, indices: [] };

		// Base reward per matched char.
		score += 10;
		// Consecutive run bonus.
		if (prevMatchIndex !== -1 && found === prevMatchIndex + 1) score += 15;
		// Word-boundary / start bonus.
		if (isBoundary(target, found)) score += 20;
		// Exact-case match bonus (small).
		if (target[found] === q[qi]) score += 2;
		// Gap penalty between this match and the previous one.
		if (prevMatchIndex !== -1) {
			const gap = found - prevMatchIndex - 1;
			if (gap > 0) score -= Math.min(gap, 10);
		} else {
			// Penalize a late first match (prefer matches near the start).
			score -= Math.min(found, 10);
		}

		indices.push(found);
		prevMatchIndex = found;
	}

	// Whole-string exact match is the strongest signal.
	if (lowerTarget === lowerQuery) score += 50;
	// Prefer shorter targets on otherwise-equal matches (slight nudge).
	score -= Math.min(target.length, 30) * 0.1;

	return { matched: true, score, indices };
}

/**
 * Rank `items` by how well `key(item)` fuzzy-matches `query`. Non-matching items
 * are dropped. For an empty query, every item is kept in its original order.
 */
export function fuzzyRank<T>(query: string, items: T[], key: (item: T) => string): FuzzyResult<T>[] {
	const q = query.trim();
	const scored: { result: FuzzyResult<T>; order: number }[] = [];
	for (let i = 0; i < items.length; i++) {
		const m = fuzzyScore(q, key(items[i]));
		if (!m.matched) continue;
		scored.push({ result: { item: items[i], score: m.score, indices: m.indices }, order: i });
	}
	if (q.length === 0) return scored.map((s) => s.result);
	scored.sort((a, b) => b.result.score - a.result.score || a.order - b.order);
	return scored.map((s) => s.result);
}
