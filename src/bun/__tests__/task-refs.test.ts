import { describe, expect, it } from "vitest";
import {
	findRefsInText,
	formatPrRef,
	formatTaskRef,
	formatTaskRefFor,
	normalizeTaskArg,
	parseRefUri,
	projectMatchesQualifier,
	refUri,
} from "../../shared/task-refs";

const PROJECT = "a1c9fe4e-8389-4214-9018-4a2580c261f0";

describe("formatters", () => {
	it("emits the canonical tokens", () => {
		expect(formatTaskRef(115)).toBe("<seq:115>");
		expect(formatPrRef(42)).toBe("<pr:42>");
		expect(formatTaskRef(115, PROJECT)).toBe("<seq:a1c9fe4e/115>");
		expect(formatPrRef(42, PROJECT)).toBe("<pr:a1c9fe4e/42>");
	});

	it("qualifies only across projects", () => {
		expect(formatTaskRefFor(7, PROJECT, PROJECT)).toBe("<seq:7>");
		expect(formatTaskRefFor(7, PROJECT, "other")).toBe("<seq:a1c9fe4e/7>");
		expect(formatTaskRefFor(7, PROJECT, undefined)).toBe("<seq:a1c9fe4e/7>");
	});

	it("round-trips through the parser", () => {
		for (const token of [formatTaskRef(1), formatPrRef(2185, PROJECT)]) {
			const [match] = findRefsInText(`see ${token} now`);
			expect(match.raw).toBe(token);
			expect(`<${refUri(match.ref)}>`).toBe(token);
		}
	});
});

describe("findRefsInText", () => {
	it("finds canonical task and PR tokens with positions", () => {
		const text = "Done in <seq:115>, opened <pr:2187>.";
		const found = findRefsInText(text);
		expect(found.map((m) => m.ref)).toEqual([
			{ kind: "task", number: 115 },
			{ kind: "pr", number: 2187 },
		]);
		expect(text.slice(found[0].start, found[0].end)).toBe("<seq:115>");
		expect(text.slice(found[1].start, found[1].end)).toBe("<pr:2187>");
	});

	it("reads the project qualifier", () => {
		expect(findRefsInText("<seq:a1c9fe4e/115>")[0].ref).toEqual({ kind: "task", number: 115, project: "a1c9fe4e" });
		expect(findRefsInText("<pr:dev-3.0/9>")[0].ref).toEqual({ kind: "pr", number: 9, project: "dev-3.0" });
	});

	it("tolerates the bare form a markdown renderer leaves behind", () => {
		expect(findRefsInText("task seq:2319 is starting")[0]).toMatchObject({ raw: "seq:2319", ref: { kind: "task", number: 2319 } });
		expect(findRefsInText("dev3 message --task seq:1801 --subject x")[0].ref.number).toBe(1801);
		expect(findRefsInText("(pr:12)")[0].ref).toEqual({ kind: "pr", number: 12 });
		expect(findRefsInText("SEQ:3")[0].ref).toEqual({ kind: "task", number: 3 });
	});

	it("does not teach or match the legacy prose forms", () => {
		expect(findRefsInText("#115 and seq 115 and task 115 and PR #3")).toEqual([]);
	});

	it("ignores look-alikes glued to words, paths and URLs", () => {
		expect(findRefsInText("https://example.com/seq:1")).toEqual([]);
		expect(findRefsInText("foo-seq:1 bar_pr:2 x.seq:3")).toEqual([]);
		expect(findRefsInText("seq:12abc seq:0 seq:")).toEqual([]);
		expect(findRefsInText("<seq:12")).toEqual([]);
		expect(findRefsInText("seq:12345678901")).toEqual([]);
	});

	it("returns nothing for empty input", () => {
		expect(findRefsInText("")).toEqual([]);
	});
});

describe("parseRefUri", () => {
	it("accepts hrefs with and without brackets", () => {
		expect(parseRefUri("seq:115")).toEqual({ kind: "task", number: 115 });
		expect(parseRefUri("<pr:a1c9fe4e/7>")).toEqual({ kind: "pr", number: 7, project: "a1c9fe4e" });
	});

	it("rejects anything else", () => {
		expect(parseRefUri("https://github.com/x/y/pull/1")).toBeNull();
		expect(parseRefUri("seq:abc")).toBeNull();
		expect(parseRefUri("seq:1 trailing")).toBeNull();
	});
});

describe("projectMatchesQualifier", () => {
	const project = { id: PROJECT, name: "dev-3.0" };
	it("matches an id prefix or the name", () => {
		expect(projectMatchesQualifier(project, "a1c9fe4e")).toBe(true);
		expect(projectMatchesQualifier(project, "A1C9")).toBe(true);
		expect(projectMatchesQualifier(project, "DEV-3.0")).toBe(true);
	});
	it("refuses a too-short prefix and strangers", () => {
		expect(projectMatchesQualifier(project, "a1c")).toBe(false);
		expect(projectMatchesQualifier(project, "homebrew-dev3")).toBe(false);
	});
});

describe("normalizeTaskArg", () => {
	it("turns a pasted token into the CLI's seq form", () => {
		expect(normalizeTaskArg("<seq:115>")).toBe("seq:115");
		expect(normalizeTaskArg("seq:115")).toBe("seq:115");
		expect(normalizeTaskArg("a1c9fe4e")).toBe("a1c9fe4e");
		expect(normalizeTaskArg("<seq:proj/1>")).toBe("<seq:proj/1>");
	});
});
