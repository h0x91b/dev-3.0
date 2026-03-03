/**
 * Pure utility functions used by the main process entry point (index.ts).
 * Extracted here so they can be tested without triggering Electrobun side effects.
 */

/**
 * Returns the ISO 8601 week number for a given date.
 */
export const getISOWeek = (d: Date): number => {
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

/**
 * Formats a Date into a human-readable string with weekday, date, ISO week, and time.
 * Example: "Mon, 3 Mar 2025 · W09 · 14:30:05"
 */
export const formatDateTime = (d: Date) => {
	const date = d.toLocaleDateString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	});
	const time = d.toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	return `${date} · W${String(getISOWeek(d)).padStart(2, "0")} · ${time}`;
};

/**
 * Builds the window title string.
 */
export const makeTitle = (version: string, dt: string) =>
	`dev-3.0 v${version} [${dt}]`;
