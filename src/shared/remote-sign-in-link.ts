/**
 * The bookmarkable sign-in link: `<access-url>#code=<access-code>`.
 *
 * The code rides the URL **fragment**, never the query. A fragment is resolved
 * entirely by the browser and is never put on the wire, so the code stays out of
 * the Cloudflare tunnel's logs, any reverse proxy's access log, and the Referer
 * header — which is exactly what a `?token=<code>` could not promise.
 *
 * It does NOT keep the code out of the browser's own history: a fragment is part
 * of the URL like anything else. The renderer strips it with `replaceState` on
 * the first paint, and a link the user bookmarks deliberately holds the code for
 * as long as the bookmark lives. That is the trade the link exists to make —
 * clicking a bookmark beats typing 30 characters on a phone. See
 * `decisions/2026/08/28/static-access-code-as-a-real-credential.md`.
 *
 * Shared so the builder (bun, CLI) and the reader (renderer) cannot drift.
 */

export const SIGN_IN_CODE_FRAGMENT_KEY = "code";

/** `https://host/?token=abc` + `s3same` → `https://host/?token=abc#code=s3same`. */
export function buildSignInLink(accessUrl: string, code: string): string {
	const base = accessUrl.split("#")[0];
	return `${base}#${SIGN_IN_CODE_FRAGMENT_KEY}=${encodeURIComponent(code)}`;
}

/**
 * Pull the access code out of a `location.hash`. Returns null for an absent,
 * empty or malformed fragment — a bad link must fall through to the sign-in
 * screen, never throw during boot.
 */
export function readCodeFromFragment(hash: string | null | undefined): string | null {
	if (!hash) return null;
	const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
	const raw = params.get(SIGN_IN_CODE_FRAGMENT_KEY);
	return raw && raw.trim() ? raw : null;
}

/**
 * The same fragment with the code removed — anything else the fragment carried
 * survives, the way the query's `?streamer=on` does.
 */
export function stripCodeFromFragment(hash: string | null | undefined): string {
	if (!hash) return "";
	const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
	if (!params.has(SIGN_IN_CODE_FRAGMENT_KEY)) return hash.startsWith("#") ? hash.slice(1) : hash;
	params.delete(SIGN_IN_CODE_FRAGMENT_KEY);
	return params.toString();
}
