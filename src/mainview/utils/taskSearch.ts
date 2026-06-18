import type { Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { fuzzyScore } from "./fuzzyMatch";

interface SearchOptions {
	/** PR number associated with the task's branch (from BranchStatus), if available. */
	prNumber?: number | null;
}

/**
 * Check if a task matches a search query.
 *
 * Textual fields (title, description) use the shared fzf-style fuzzy matcher
 * (`fuzzyScore`) so task search behaves like the project quick-switch palette:
 * a query matches when its chars appear in order (subsequence), not only as a
 * contiguous substring. Identifier fields (seq, UUID, PR number) keep strict
 * prefix matching — fuzzy subsequence on short numeric IDs would be meaningless.
 * All comparisons are case-insensitive.
 */
export function matchesSearchQuery(task: Task, query: string, options?: SearchOptions): boolean {
	const q = query.trim().toLowerCase();
	if (q === "") return true;

	// Strip leading # for numeric ID search
	const qNormalized = q.startsWith("#") ? q.slice(1) : q;

	// Fuzzy match against title (custom or auto-generated)
	if (fuzzyScore(q, getTaskTitle(task)).matched) return true;

	// Fuzzy match against description
	if (fuzzyScore(q, task.description).matched) return true;

	// Match against seq (numeric human-readable ID) — prefix match on string representation
	const seqStr = String(task.seq);
	if (seqStr.startsWith(qNormalized)) return true;

	// Match against full UUID (id) — prefix match, case-insensitive
	if (task.id.toLowerCase().startsWith(q)) return true;

	// Match against PR number (if provided) — prefix match, supports "PR" and "#PR" prefixes
	const prNumber = options?.prNumber;
	if (prNumber != null) {
		const prStr = String(prNumber);
		if (prStr.startsWith(qNormalized)) return true;
		// Support "pr123" or "PR123" prefix
		const qLower = q.replace(/^pr\s*/i, "");
		if (qLower && prStr.startsWith(qLower)) return true;
	}

	return false;
}
