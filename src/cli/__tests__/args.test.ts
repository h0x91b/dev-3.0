import { describe, it, expect } from "vitest";
import { parseArgs } from "../args";

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
