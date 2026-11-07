import { parseRefUri } from "../../../shared/task-refs";

/**
 * Repo-relative URLs (`docs/guide.md`, `shots/board.png`) are not fetchable from
 * the webview, so Streamdown's URL hardener drops them before our component
 * overrides ever see them. To keep them, a remark plugin swaps each one for a
 * token URL that survives hardening, and the components trade the token back.
 *
 * The token carries a nonce drawn once per session, so only URLs this module
 * protected can be unwrapped — an author cannot smuggle a URL of their own
 * through by typing the prefix into a comment. `protect` takes nothing but a
 * scheme-less relative URL and `unprotect` re-checks that on the way out, so a
 * token can only ever yield a path, never a scheme.
 */

const NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
	byte.toString(16).padStart(2, "0"),
).join("");
const TOKEN_PREFIX = `https://dev3.invalid/${NONCE}/`;
// `<seq:N>` / `<pr:N>` autolinks: rehype-sanitize strips their unknown scheme,
// so they ride the same nonce trick and can only unwrap to a valid reference.
const REF_TOKEN_PREFIX = `https://dev3.invalid/${NONCE}-ref/`;

/** True for a markdown URL naming a path in the checkout rather than a location the webview can fetch. */
export function isRelativeUrl(url: string): boolean {
	return Boolean(url) && !url.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

function safeDecode(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function protect(url: string): string {
	if (parseRefUri(url)) return `${REF_TOKEN_PREFIX}${encodeURIComponent(url)}`;
	return `${TOKEN_PREFIX}${encodeURIComponent(url)}`;
}

/** The relative URL behind a token; any other URL passes through as Streamdown hardened it. */
export function unprotect(url: string | undefined): string | undefined {
	if (url?.startsWith(REF_TOKEN_PREFIX)) {
		const ref = safeDecode(url.slice(REF_TOKEN_PREFIX.length));
		return ref && parseRefUri(ref) ? ref : undefined;
	}
	if (url === undefined || !url.startsWith(TOKEN_PREFIX)) return url;
	let relative: string;
	try {
		relative = decodeURIComponent(url.slice(TOKEN_PREFIX.length));
	} catch {
		return undefined;
	}
	return isRelativeUrl(relative) ? relative : undefined;
}

/**
 * `unprotect` hands the link component an href that Streamdown's sanitizer never
 * inspected, so the scheme policy is restated at the point the value is written —
 * matching the schemes that sanitizer allows. A link in a PR comment is untrusted
 * input handed to the OS; which schemes reach it should not rest on one layer.
 */
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "irc:", "ircs:", "xmpp:"]);

/** `href` when it is safe to navigate to, `undefined` when it names a scheme we do not allow. */
export function safeLinkHref(href: string | undefined): string | undefined {
	if (href === undefined || href.startsWith("#") || isRelativeUrl(href)) return href;
	const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(href)?.[0].toLowerCase();
	return scheme && SAFE_LINK_SCHEMES.has(scheme) ? href : undefined;
}

interface MarkdownTreeNode {
	type?: string;
	url?: string;
	identifier?: string;
	children?: MarkdownTreeNode[];
}

/** Remark plugin protecting every relative image src and link href in the tree. */
export function remarkProtectRelativeUrls() {
	return (tree: MarkdownTreeNode) => {
		const references = new Set<string>();
		const definitions: MarkdownTreeNode[] = [];
		const nodes: MarkdownTreeNode[] = [tree];
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			if ((node.type === "imageReference" || node.type === "linkReference") && node.identifier) {
				references.add(node.identifier.toLowerCase());
			}
			if ((node.type === "image" || node.type === "link") && node.url && isProtectable(node.url, node.type === "link")) {
				node.url = protect(node.url);
			}
			if (node.type === "definition") definitions.push(node);
			if (node.children) nodes.push(...node.children);
		}
		for (const definition of definitions) {
			if (!definition.identifier || !definition.url || !isProtectable(definition.url, false)) continue;
			if (references.has(definition.identifier.toLowerCase())) {
				definition.url = protect(definition.url);
			}
		}
	};
}

/** In-page anchors survive hardening as they are, so they need no token. */
function isProtectable(url: string, isLink: boolean): boolean {
	return (!url.startsWith("#") && isRelativeUrl(url)) || (isLink && parseRefUri(url) !== null);
}
