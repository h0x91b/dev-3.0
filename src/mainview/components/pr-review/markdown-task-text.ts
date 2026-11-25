import { findRefsInText, refUri } from "../../../shared/task-refs";
import { findPathCandidates } from "../../../shared/path-candidates";

/**
 * Remark plugins for agent-written plain text rendered as Markdown (task
 * descriptions): bare `seq:N` / `pr:N` become reference links the way the
 * plain-text renderer already chips them, and raw HTML shows as the literal
 * text the author typed instead of being parsed or silently dropped.
 */

interface MdNode {
	type: string;
	value?: string;
	url?: string;
	children?: MdNode[];
}

/** Containers whose text is already a link label; nesting a link there is invalid. */
const LINK_TYPES = new Set(["link", "linkReference"]);

function splitRefs(value: string): MdNode[] | null {
	const matches = findRefsInText(value);
	if (matches.length === 0) return null;
	const parts: MdNode[] = [];
	let cursor = 0;
	for (const match of matches) {
		if (match.start > cursor) parts.push({ type: "text", value: value.slice(cursor, match.start) });
		const uri = refUri(match.ref);
		parts.push({ type: "link", url: uri, children: [{ type: "text", value: uri }] });
		cursor = match.end;
	}
	if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
	return parts;
}

/** Bare `seq:N` / `pr:N` in prose become links; code, inline code and existing links are left alone. */
export function remarkBareTaskRefs() {
	const walk = (node: MdNode) => {
		if (!node.children || LINK_TYPES.has(node.type)) return;
		node.children = node.children.flatMap((child) => {
			if (child.type === "text" && child.value) return splitRefs(child.value) ?? [child];
			walk(child);
			return [child];
		});
	};
	return walk;
}

/** `path` as a link URL: a `:line` suffix rides as `#L<line>`, since `a.ts:12` would read as a scheme. */
export function pathLinkUrl(path: string, line?: number): string {
	return line ? `${path}#L${line}` : path;
}

/** The path and line behind a relative link URL; any other fragment is dropped. */
export function parsePathLinkUrl(url: string): { path: string; line?: number } {
	const hash = url.indexOf("#");
	if (hash < 0) return { path: url };
	const line = /^#L(\d+)$/.exec(url.slice(hash))?.[1];
	return line ? { path: url.slice(0, hash), line: Number(line) } : { path: url.slice(0, hash) };
}

function splitPaths(value: string): MdNode[] | null {
	const candidates = findPathCandidates(value);
	if (candidates.length === 0) return null;
	const parts: MdNode[] = [];
	let cursor = 0;
	for (const candidate of candidates) {
		if (candidate.start > cursor) parts.push({ type: "text", value: value.slice(cursor, candidate.start) });
		parts.push({ type: "link", url: pathLinkUrl(candidate.cleanPath, candidate.line), children: [{ type: "text", value: candidate.raw }] });
		cursor = candidate.end + 1;
	}
	if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
	return parts;
}

/** An inline code span that is one whole path, as agents usually write them. */
function wrapCodePath(node: MdNode): MdNode | null {
	const value = node.value?.trim() ?? "";
	const [candidate] = findPathCandidates(value);
	if (!candidate || candidate.start !== 0 || candidate.end !== value.length - 1) return null;
	return { type: "link", url: pathLinkUrl(candidate.cleanPath, candidate.line), children: [node] };
}

/**
 * Path-looking text and whole-path inline code become relative links; the link
 * component checks each on disk and leaves a path that names nothing as text.
 * Code blocks and existing links are left alone.
 */
export function remarkBarePathLinks() {
	const walk = (node: MdNode) => {
		if (!node.children || LINK_TYPES.has(node.type)) return;
		node.children = node.children.flatMap((child) => {
			if (child.type === "text" && child.value) return splitPaths(child.value) ?? [child];
			if (child.type === "inlineCode") return [wrapCodePath(child) ?? child];
			walk(child);
			return [child];
		});
	};
	return walk;
}

/** Parents whose `html` children are blocks: their literal text needs a paragraph of its own. */
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);

/** Raw HTML, block or inline, renders as the literal source text. */
export function remarkHtmlAsText() {
	const walk = (node: MdNode) => {
		if (!node.children) return;
		node.children = node.children.map((child) => {
			if (child.type !== "html") {
				walk(child);
				return child;
			}
			const text: MdNode = { type: "text", value: child.value ?? "" };
			return BLOCK_PARENTS.has(node.type) ? { type: "paragraph", children: [text] } : text;
		});
	};
	return walk;
}
