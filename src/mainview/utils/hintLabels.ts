/**
 * Vimium-style hint label generator.
 *
 * Produces `count` unique hint strings drawn from `chars`, with two guarantees:
 *   1. No hint is a prefix of another (they are leaves of a trie), so once the
 *      user has typed a string that exactly equals a hint, it identifies that
 *      hint unambiguously — there is never a "wait, is there a longer one?".
 *   2. Length is minimal: single characters are used until they run out, then
 *      the shortest existing hints are expanded into multi-character ones.
 *
 * This mirrors Vimium's link-hint algorithm.
 */

/**
 * Home-row-first character set. Ordered so the easiest-to-reach keys are handed
 * out first; ambiguous-looking letters are still included because hints are
 * short and shown explicitly on screen.
 */
export const DEFAULT_HINT_CHARS = "asdfghjklqwertyuiopzxcvbnm";

/**
 * Map a physical key `code` (`KeyboardEvent.code`) to its hint character,
 * independent of the active keyboard layout. Hint chars are all a–z, whose
 * physical positions are `"KeyA"`–`"KeyZ"` on every layout (Cyrillic, Hebrew, …) —
 * so matching on `code` instead of `key` makes both hint activation and hint
 * typing work regardless of the selected input language.
 */
export function codeToHintChar(code: string): string | null {
	const m = /^Key([A-Z])$/.exec(code);
	return m ? m[1].toLowerCase() : null;
}

export function generateHintStrings(count: number, chars: string = DEFAULT_HINT_CHARS): string[] {
	if (count <= 0) return [];
	const charList = [...chars];
	if (charList.length < 2) {
		throw new Error("generateHintStrings needs at least 2 distinct characters");
	}

	// Breadth-first trie expansion. `hints` is the frontier; `offset` marks how
	// many of the leading entries have already been expanded into children and
	// are therefore no longer usable leaves. The number of usable leaves at any
	// moment is `hints.length - offset`.
	const hints: string[] = [""];
	let offset = 0;
	while (hints.length - offset < count || hints.length === 1) {
		const prefix = hints[offset++];
		for (const c of charList) hints.push(prefix + c);
	}

	return hints.slice(offset, offset + count);
}
