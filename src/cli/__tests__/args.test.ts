import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, resolveFileArgs } from "../args";

describe("parseArgs", () => {
	it("parses positionals, --key value, --key=value (keeping later =) and valueless boolean flags", () => {
		expect(parseArgs([])).toMatchObject({ positional: [], flags: {} });
		expect(parseArgs(["show", "abc123"])).toMatchObject({ positional: ["show", "abc123"], flags: {} });
		expect(parseArgs(["--project", "abc", "--status=in-progress", "--title=foo=bar", "--help"])).toMatchObject({
			positional: [],
			flags: { project: "abc", status: "in-progress", title: "foo=bar", help: "true" },
		});
	});

	it("does not let a boolean flag eat the next flag, and mixes positionals with flags", () => {
		expect(parseArgs(["--force", "--project", "abc"]).flags).toEqual({ force: "true", project: "abc" });
		const result = parseArgs(["abc123", "--status", "todo", "--project", "xyz"]);
		expect(result.positional).toEqual(["abc123"]);
		expect(result.flags).toEqual({ status: "todo", project: "xyz" });
	});
});

describe("resolveFileArgs", () => {
	const testDir = join(tmpdir(), `dev3-args-test-${process.pid}`);

	function createFile(name: string, content: string): string {
		const filePath = join(testDir, name);
		writeFileSync(filePath, content);
		return filePath;
	}

	beforeAll(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("reads file content for @ flag values and positionals, including empty files", () => {
		const titleFile = createFile("title.txt", "File-based title");
		const descFile = createFile("desc.md", "# My Plan\nDo stuff");
		const noteFile = createFile("note.txt", "Important note");
		const emptyFile = createFile("empty.txt", "");
		const result = resolveFileArgs({
			flags: { title: `@${titleFile}`, description: `@${descFile}`, body: `@${emptyFile}` },
			positional: [`@${noteFile}`],
		});
		expect(result.flags).toMatchObject({ title: "File-based title", description: "# My Plan\nDo stuff", body: "" });
		expect(result.positional[0]).toBe("Important note");
	});

	it("escapes @@ to a literal @ and leaves plain values and boolean flags unchanged", () => {
		const result = resolveFileArgs({
			flags: { title: "@@mention", status: "todo", help: "true" },
			positional: ["@@other", "abc123"],
		});
		expect(result.flags).toEqual({ title: "@mention", status: "todo", help: "true" });
		expect(result.positional).toEqual(["@other", "abc123"]);
	});

	it("throws a descriptive error for a missing file or a directory", () => {
		expect(() => resolveFileArgs({ flags: { description: "@/nonexistent/path.txt" }, positional: [] })).toThrow(
			/File not found.*nonexistent\/path\.txt/,
		);
		expect(() => resolveFileArgs({ flags: { description: `@${testDir}` }, positional: [] })).toThrow(/directory/i);
	});
});

describe("parseArgs repeated flags", () => {
	// `flags` cannot express a repeatable flag: the last value wins. `repeated`
	// keeps every occurrence so `dev3 dev-server start --env A=1 --env B=2` works.
	it("records every occurrence of a flag in order", () => {
		const result = parseArgs(["--env", "A=1", "--env", "B=2"]);
		expect(result.repeated?.env).toEqual(["A=1", "B=2"]);
		expect(result.flags.env).toBe("B=2");
		expect(parseArgs(["--env=A=1", "--env=B=2"]).repeated?.env).toEqual(["A=1", "B=2"]);
	});

	// A bare `--env` with nothing after it parses as the boolean "true"; the
	// dev-server command turns that into its own usage error.
	it("records a valueless flag as \"true\"", () => {
		expect(parseArgs(["--env"]).repeated?.env).toEqual(["true"]);
		// A single occurrence is a one-element list.
		expect(parseArgs(["--wait", "--timeout", "5"]).repeated).toEqual({ wait: ["true"], timeout: ["5"] });
	});
});

describe("parseArgs passthrough", () => {
	it("is undefined without a bare --, and an empty list when -- has nothing after it", () => {
		expect(parseArgs(["start", "--wait"]).passthrough).toBeUndefined();
		expect(parseArgs(["--"]).passthrough).toEqual([]);
	});

	it("takes everything after the first -- verbatim, without parsing it as flags", () => {
		const result = parseArgs(["start", "--", "--own-db", "a b", "--", "@file"]);
		expect(result.passthrough).toEqual(["--own-db", "a b", "--", "@file"]);
		expect(result.positional).toEqual(["start"]);
		expect(result.flags).toEqual({});
	});

	it("does not swallow -- as the value of a preceding flag", () => {
		const result = parseArgs(["--wait", "--", "--x"]);
		expect(result.flags).toEqual({ wait: "true" });
		expect(result.passthrough).toEqual(["--x"]);
	});

	it("survives resolveFileArgs without @file resolution", () => {
		const resolved = resolveFileArgs(parseArgs(["--", "@/nonexistent/file", "@@x"]));
		expect(resolved.passthrough).toEqual(["@/nonexistent/file", "@@x"]);
	});
});
