// ---- Task epic ----

/** Longest epic name kept; a name is a board filter token, not a sentence. */
export const MAX_EPIC_LENGTH = 48;

/**
 * Reduces free-form input to the one canonical kebab-case form, so the same
 * epic typed two ways on two repos still groups as one. Returns `null` for
 * input with no usable characters or longer than {@link MAX_EPIC_LENGTH}.
 */
export function normalizeEpic(input: string): string | null {
	const slug = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug && slug.length <= MAX_EPIC_LENGTH ? slug : null;
}
