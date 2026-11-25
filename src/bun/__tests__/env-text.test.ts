import { describe, expect, it } from "vitest";
import { parseEnvText, serializeEnvText, sanitizeEnvMap, validateEnvMap } from "../../shared/env-text";

describe("parseEnvText", () => {
	it("parses KEY=value lines: value verbatim after the first =, CRLF, empty values, comments skipped, last duplicate wins", () => {
		expect(parseEnvText("FOO=bar\nBAZ=qux").env).toEqual({ FOO: "bar", BAZ: "qux" });
		expect(parseEnvText("URL=https://x.dev/?a=1&b=2").env).toEqual({ URL: "https://x.dev/?a=1&b=2" });
		expect(parseEnvText("MSG= hello world ").env).toEqual({ MSG: " hello world " });
		expect(parseEnvText("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ env: { FOO: "bar", BAZ: "qux" }, errors: [] });
		expect(parseEnvText("EMPTY=").env).toEqual({ EMPTY: "" });
		expect(parseEnvText("# comment\n\n  \nFOO=1\n  # indented comment")).toEqual({ env: { FOO: "1" }, errors: [] });
		expect(parseEnvText("A=1\nA=2").env).toEqual({ A: "2" });
	});

	it("reports invalid lines with 1-based line numbers", () => {
		const { env, errors } = parseEnvText("FOO=1\nnot a var\n2BAD=x");
		expect(env).toEqual({ FOO: "1" });
		expect(errors).toEqual([
			{ line: 2, text: "not a var" },
			{ line: 3, text: "2BAD=x" },
		]);
	});

});

describe("serializeEnvText", () => {
	it("round-trips with parseEnvText, and is empty for an empty map", () => {
		const env = { FOO: "bar", URL: "https://x.dev/?a=1", EMPTY: "" };
		expect(parseEnvText(serializeEnvText(env)).env).toEqual(env);
		expect(serializeEnvText({})).toBe("");
	});
});

describe("sanitizeEnvMap", () => {
	it("returns {} for non-objects, and silently for undefined (not configured)", () => {
		const warnings: string[] = [];
		expect(sanitizeEnvMap(null)).toEqual({});
		expect(sanitizeEnvMap("FOO=1")).toEqual({});
		expect(sanitizeEnvMap([1, 2])).toEqual({});
		expect(sanitizeEnvMap(undefined, (m) => warnings.push(m))).toEqual({});
		expect(warnings).toEqual([]);
	});

	it("drops non-string values and invalid keys, keeps the rest, warns per drop", () => {
		const warnings: string[] = [];
		const out = sanitizeEnvMap({ GOOD: "1", BAD_NUM: 2, "2BAD": "x" }, (m) => warnings.push(m));
		expect(out).toEqual({ GOOD: "1" });
		expect(warnings.length).toBe(2);
	});
});

describe("validateEnvMap", () => {
	it("accepts a valid map and undefined; rejects non-object, invalid keys, non-string values", () => {
		expect(validateEnvMap({ FOO: "bar" })).toEqual([]);
		expect(validateEnvMap(undefined)).toEqual([]);
		expect(validateEnvMap("x").length).toBe(1);
		expect(validateEnvMap({ "2BAD": "x" }).length).toBe(1);
		expect(validateEnvMap({ FOO: 3 }).length).toBe(1);
	});

	it("rejects line breaks in values", () => {
		expect(validateEnvMap({ LF: "a\nb", CR: "a\rb" })).toEqual([
			"env var LF must not contain line breaks",
			"env var CR must not contain line breaks",
		]);
	});
});
