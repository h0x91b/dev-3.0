import { findRefsInText, refUri } from "../../../shared/task-refs";

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
