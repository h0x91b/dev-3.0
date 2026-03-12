import type { Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";

interface SearchOptions {
	/** PR number associated with the task's branch (from BranchStatus), if available. */
	prNumber?: number | null;
}

/**
 * Check if a task matches a search query.
 * Searches across: title, description, seq (numeric ID), UUID (full + short prefix),
 * and optionally PR number (when provided via options).
 * All comparisons are case-insensitive.
 */
export function matchesSearchQuery(task: Task, query: string, options?: SearchOptions): boolean {
	const q = query.trim().toLowerCase();
	if (q === "") return true;

	// Strip leading # for numeric ID search
	const qNormalized = q.startsWith("#") ? q.slice(1) : q;

	// Match against title (custom or auto-generated)
	if (getTaskTitle(task).toLowerCase().includes(q)) return true;

	// Match against description
	if (task.description.toLowerCase().includes(q)) return true;

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
