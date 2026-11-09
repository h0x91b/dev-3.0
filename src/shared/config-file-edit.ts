/**
 * Edit one top-level key of a JSON config file while keeping the rest of the
 * text as the author wrote it: key order, indentation, line endings, inline
 * arrays, the final newline. Only the edited member's text changes.
 */

export interface JsonTextFormat {
	indent: string;
	eol: string;
	finalNewline: boolean;
}

const DEFAULT_FORMAT: JsonTextFormat = { indent: "  ", eol: "\n", finalNewline: true };

export function detectJsonFormat(text: string): JsonTextFormat {
	if (!text.trim()) return DEFAULT_FORMAT;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const indentMatch = /\n([ \t]+)\S/.exec(text);
	return {
		indent: indentMatch ? indentMatch[1] : DEFAULT_FORMAT.indent,
		eol,
		finalNewline: /\r?\n$/.test(text),
	};
}

export function stringifyJsonText(value: unknown, format: JsonTextFormat = DEFAULT_FORMAT): string {
	const body = JSON.stringify(value, null, format.indent).replaceAll("\n", format.eol);
	return format.finalNewline ? body + format.eol : body;
}

interface Member {
	key: string;
	/** Offset of the key's opening quote. */
	start: number;
	valueStart: number;
	valueEnd: number;
}

/** Top-level members of a JSON object text, or null when the text is not one. */
function scanMembers(text: string): { members: Member[]; open: number; close: number } | null {
	let i = 0;
	const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
	const skipString = () => {
		i++;
		while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
		i++;
	};
	const skipValue = () => {
		if (text[i] === '"') return skipString();
		if (text[i] === "{" || text[i] === "[") {
			let depth = 0;
			while (i < text.length) {
				const c = text[i];
				if (c === '"') { skipString(); continue; }
				if (c === "{" || c === "[") depth++;
				if (c === "}" || c === "]") depth--;
				i++;
				if (depth === 0) return;
			}
			return;
		}
		while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
	};
	ws();
	if (text[i] !== "{") return null;
	const open = i++;
	const members: Member[] = [];
	for (;;) {
		ws();
		if (text[i] === "}") return { members, open, close: i };
		if (text[i] !== '"') return null;
		const start = i;
		skipString();
		const key = JSON.parse(text.slice(start, i)) as string;
		ws();
		if (text[i++] !== ":") return null;
		ws();
		const valueStart = i;
		skipValue();
		members.push({ key, start, valueStart, valueEnd: i });
		ws();
		if (text[i] === ",") { i++; continue; }
		if (text[i] === "}") return { members, open, close: i };
		return null;
	}
}

function lineIndentAt(text: string, offset: number): string | null {
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	const prefix = text.slice(lineStart, offset);
	return /^[ \t]*$/.test(prefix) ? prefix : null;
}

function memberValueText(value: unknown, memberIndent: string, format: JsonTextFormat): string {
	return JSON.stringify(value, null, format.indent).split("\n").join(format.eol + memberIndent);
}

/**
 * Return `text` with top-level `key` set to `value`, or removed when `value` is
 * undefined. Falls back to a full re-stringify in the file's own format when
 * the text cannot be spliced safely; either way the result parses to `expected`.
 */
export function editJsonMember(text: string, key: string, value: unknown, expected: Record<string, unknown>): string {
	const format = detectJsonFormat(text);
	const fallback = () => stringifyJsonText(expected, format);
	const scan = text.trim() ? scanMembers(text) : null;
	if (!scan) return fallback();
	const { members, close } = scan;
	const index = members.findIndex((m) => m.key === key);
	let out: string | null = null;

	if (index !== -1 && value !== undefined) {
		const m = members[index];
		const indent = lineIndentAt(text, m.start) ?? "";
		out = text.slice(0, m.valueStart) + memberValueText(value, indent, format) + text.slice(m.valueEnd);
	} else if (index !== -1) {
		const m = members[index];
		if (members.length === 1) {
			out = text.slice(0, scan.open + 1) + text.slice(close);
			out = out.replace(/\{\s*\}/, "{}");
		} else if (index < members.length - 1) {
			out = text.slice(0, m.start) + text.slice(members[index + 1].start);
		} else {
			out = text.slice(0, members[index - 1].valueEnd) + text.slice(m.valueEnd);
		}
	} else if (value !== undefined && members.length > 0) {
		const last = members[members.length - 1];
		const indent = lineIndentAt(text, last.start);
		if (indent !== null) {
			out = text.slice(0, last.valueEnd)
				+ `,${format.eol}${indent}${JSON.stringify(key)}: ${memberValueText(value, indent, format)}`
				+ text.slice(last.valueEnd);
		}
	}

	if (out === null) return fallback();
	try {
		if (JSON.stringify(JSON.parse(out)) === JSON.stringify(expected)) return out;
	} catch {
		// Splice produced invalid JSON: use the safe path.
	}
	return fallback();
}
