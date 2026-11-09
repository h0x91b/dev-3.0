import { describe, it, expect } from "vitest";
import { detectJsonFormat, editJsonMember } from "../../shared/config-file-edit";

function edit(text: string, key: string, value: unknown): string {
	const obj = JSON.parse(text) as Record<string, unknown>;
	const expected: Record<string, unknown> = { ...obj };
	if (value === undefined) delete expected[key];
	else expected[key] = value;
	const out = editJsonMember(text, key, value, expected);
	expect(JSON.parse(out)).toEqual(expected);
	return out;
}

describe("editJsonMember", () => {
	const TABS = '{\n\t"setupScript": "npm i",\n\t"clonePaths": ["node_modules", ".env"],\n\t"portCount": 1\n}\n';

	it("replaces one value and leaves every other byte alone", () => {
		expect(edit(TABS, "portCount", 3)).toBe(TABS.replace('"portCount": 1', '"portCount": 3'));
	});

	it("keeps an inline array on another key inline", () => {
		expect(edit(TABS, "setupScript", "bun install")).toContain('"clonePaths": ["node_modules", ".env"]');
	});

	it("appends a new key in the file's indentation", () => {
		expect(edit(TABS, "defaultBaseBranch", "develop")).toBe(
			'{\n\t"setupScript": "npm i",\n\t"clonePaths": ["node_modules", ".env"],\n\t"portCount": 1,\n\t"defaultBaseBranch": "develop"\n}\n',
		);
	});

	it("indents a multi-line value to its member", () => {
		const out = edit('{\n  "a": 1\n}\n', "env", { X: "1" });
		expect(out).toBe('{\n  "a": 1,\n  "env": {\n    "X": "1"\n  }\n}\n');
	});

	it("removes the first, a middle and the last member", () => {
		expect(edit(TABS, "setupScript", undefined)).toBe('{\n\t"clonePaths": ["node_modules", ".env"],\n\t"portCount": 1\n}\n');
		expect(edit(TABS, "clonePaths", undefined)).toBe('{\n\t"setupScript": "npm i",\n\t"portCount": 1\n}\n');
		expect(edit(TABS, "portCount", undefined)).toBe('{\n\t"setupScript": "npm i",\n\t"clonePaths": ["node_modules", ".env"]\n}\n');
	});

	it("removes the only member", () => {
		expect(edit('{\n  "a": 1\n}\n', "a", undefined)).toBe("{}\n");
	});

	it("keeps CRLF line endings and a missing final newline", () => {
		const text = '{\r\n  "a": "x,}"\r\n}';
		const out = edit(text, "b", true);
		expect(out).toBe('{\r\n  "a": "x,}",\r\n  "b": true\r\n}');
	});

	it("handles strings holding braces, quotes and escapes", () => {
		const text = '{\n  "s": "a \\"}\\" b {",\n  "n": 1\n}\n';
		expect(edit(text, "n", 2)).toBe('{\n  "s": "a \\"}\\" b {",\n  "n": 2\n}\n');
	});

	it("re-stringifies a compact file in its own format", () => {
		expect(edit('{"a":1}', "b", 2)).toBe('{\n  "a": 1,\n  "b": 2\n}');
	});

	it("creates content for an empty file", () => {
		expect(editJsonMember("", "a", 1, { a: 1 })).toBe('{\n  "a": 1\n}\n');
	});
});

describe("detectJsonFormat", () => {
	it("reads indent, line ending and final newline", () => {
		expect(detectJsonFormat('{\r\n    "a": 1\r\n}')).toEqual({ indent: "    ", eol: "\r\n", finalNewline: false });
	});
});
