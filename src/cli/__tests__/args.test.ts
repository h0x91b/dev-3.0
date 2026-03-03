import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, resolveFileArgs } from "../args";

describe("parseArgs", () => {
	it("parses positional arguments", () => {
		const result = parseArgs(["show", "abc123"]);
		expect(result.positional).toEqual(["show", "abc123"]);
		expect(result.flags).toEqual({});
	});

	it("parses --key value flags", () => {
		const result = parseArgs(["--project", "abc", "--status", "todo"]);
		expect(result.flags).toEqual({ project: "abc", status: "todo" });
		expect(result.positional).toEqual([]);
	});

	it("parses --key=value flags", () => {
		const result = parseArgs(["--project=abc", "--status=in-progress"]);
		expect(result.flags).toEqual({ project: "abc", status: "in-progress" });
	});

	it("handles boolean flags (no value)", () => {
		const result = parseArgs(["--help"]);
		expect(result.flags).toEqual({ help: "true" });
	});

	it("handles boolean flag followed by another flag", () => {
		const result = parseArgs(["--force", "--project", "abc"]);
		expect(result.flags).toEqual({ force: "true", project: "abc" });
	});

	it("mixes positional and flags", () => {
		const result = parseArgs(["abc123", "--status", "todo", "--project", "xyz"]);
		expect(result.positional).toEqual(["abc123"]);
		expect(result.flags).toEqual({ status: "todo", project: "xyz" });
	});

	it("handles --key=value with equals in value", () => {
		const result = parseArgs(["--title=foo=bar"]);
		expect(result.flags).toEqual({ title: "foo=bar" });
	});

	it("returns empty for no args", () => {
		const result = parseArgs([]);
		expect(result.positional).toEqual([]);
		expect(result.flags).toEqual({});
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

	it("reads file content for flag values starting with @", () => {
		const filePath = createFile("desc.md", "# My Plan\nDo stuff");
		const result = resolveFileArgs({
			flags: { description: `@${filePath}` },
			positional: [],
		});
		expect(result.flags.description).toBe("# My Plan\nDo stuff");
	});

	it("reads file content for positional args starting with @", () => {
		const filePath = createFile("note.txt", "Important note");
		const result = resolveFileArgs({
			flags: {},
			positional: [`@${filePath}`],
		});
		expect(result.positional[0]).toBe("Important note");
	});

	it("escapes @@ to literal @", () => {
		const result = resolveFileArgs({
			flags: { title: "@@mention" },
			positional: ["@@other"],
		});
		expect(result.flags.title).toBe("@mention");
		expect(result.positional[0]).toBe("@other");
	});

	it("leaves non-@ values unchanged", () => {
		const result = resolveFileArgs({
			flags: { status: "todo", title: "Normal title" },
			positional: ["abc123"],
		});
		expect(result.flags.status).toBe("todo");
		expect(result.flags.title).toBe("Normal title");
		expect(result.positional[0]).toBe("abc123");
	});

	it("does not resolve boolean flags (value === 'true')", () => {
		const result = resolveFileArgs({
			flags: { help: "true" },
			positional: [],
		});
		expect(result.flags.help).toBe("true");
	});

	it("throws descriptive error for missing file", () => {
		expect(() =>
			resolveFileArgs({
				flags: { description: "@/nonexistent/path.txt" },
				positional: [],
			}),
		).toThrow(/File not found.*nonexistent\/path\.txt/);
	});

	it("throws descriptive error when path is a directory", () => {
		expect(() =>
			resolveFileArgs({
				flags: { description: `@${testDir}` },
				positional: [],
			}),
		).toThrow(/directory/i);
	});

	it("handles multiple flags with @file references", () => {
		const titleFile = createFile("title.txt", "File-based title");
		const descFile = createFile("desc2.md", "Long description\nwith newlines");
		const result = resolveFileArgs({
			flags: { title: `@${titleFile}`, description: `@${descFile}` },
			positional: [],
		});
		expect(result.flags.title).toBe("File-based title");
		expect(result.flags.description).toBe("Long description\nwith newlines");
	});

	it("handles empty file", () => {
		const filePath = createFile("empty.txt", "");
		const result = resolveFileArgs({
			flags: { description: `@${filePath}` },
			positional: [],
		});
		expect(result.flags.description).toBe("");
	});
});
