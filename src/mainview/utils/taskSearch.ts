import type { Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";

/**
 * Check if a task matches a search query.
 * Searches across: title, description, seq (numeric ID), and UUID (full + short prefix).
 * All comparisons are case-insensitive.
 */
export function matchesSearchQuery(task: Task, query: string): boolean {
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

	return false;
}
