import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import { annotatePathRefs, findPathRefsInText, formatPathRef, LAUNCH_ANNOTATION_MAX_ADDED_CHARS, parsePathRefUri, projectRelative, qualifyPathsFor, stripPathAnnotations } from "../../shared/path-refs";
import { resolvePathRefIn, underRoot } from "../path-ref-resolve";

const WRITER = "a1c9fe4e-0000-4000-8000-000000000001";
const READER = "b2d0aa11-0000-4000-8000-000000000002";

describe("path token grammar", () => {
	it("reads the bracketed and bare forms, with and without a line", () => {
		const found = findPathRefsInText("see <path:a1c9fe4e/todo/x.md> and path:AI-Work/src/app.ts:12.");
		expect(found.map((m) => m.ref)).toEqual([
			{ project: "a1c9fe4e", path: "todo/x.md" },
			{ project: "AI-Work", path: "src/app.ts", line: 12 },
		]);
		expect(found[1]!.raw).toBe("path:AI-Work/src/app.ts:12");
	});

	it("drops sentence punctuation from a bare token", () => {
		expect(findPathRefsInText("brief at path:a1c9fe4e/todo/x.md.")[0]!.raw).toBe("path:a1c9fe4e/todo/x.md");
	});

	it("reads a trailing directory slash as the directory, not an empty segment", () => {
		const [found] = findPathRefsInText("see path:a1c9fe4e/docs/.");
		expect(found!.ref).toEqual({ project: "a1c9fe4e", path: "docs" });
		expect(parsePathRefUri("path:a1c9fe4e/docs//x.md")).toBeNull();
	});

	it("refuses a token that climbs out of its project", () => {
		expect(parsePathRefUri("path:a1c9fe4e/../etc/passwd")).toBeNull();
		expect(parsePathRefUri("path:a1c9fe4e/a/./b")).toBeNull();
		expect(findPathRefsInText("path:a1c9fe4e/../../x")).toEqual([]);
	});

	it("is not glued to a word or URL", () => {
		expect(findPathRefsInText("xpath:a1c9fe4e/a.md https://h/path:a1c9fe4e/a.md")).toEqual([]);
	});

	it("round-trips through the formatter", () => {
		expect(formatPathRef({ project: "a1c9fe4e", path: "a/b.md", line: 3 })).toBe("<path:a1c9fe4e/a/b.md:3>");
		expect(parsePathRefUri("<path:a1c9fe4e/a/b.md:3>")).toEqual({ project: "a1c9fe4e", path: "a/b.md", line: 3 });
	});
});

describe("projectRelative", () => {
	it("normalizes either separator and refuses rooted or climbing paths", () => {
		expect(projectRelative("todo\\x.md")).toBe("todo/x.md");
		expect(projectRelative("./todo/x.md")).toBe("todo/x.md");
		for (const p of ["/abs/x", "C:\\x", "~/x", "../x", "a/../b"]) expect(projectRelative(p)).toBeNull();
	});
});

describe("qualifyPathsFor", () => {
	const exists = (p: string) => p === "todo/x.md" || p === "src/app.ts";

	it("turns a writer's existing relative path into its token, keeping the line", () => {
		expect(qualifyPathsFor("brief: todo/x.md, bug at src\\app.ts:4, gone: no/such.md", WRITER, READER, exists))
			.toBe("brief: path:a1c9fe4e/todo/x.md, bug at path:a1c9fe4e/src/app.ts:4, gone: no/such.md");
	});

	it("leaves same-board text, absolute paths, URLs, refs, tokens and fenced code alone", () => {
		expect(qualifyPathsFor("todo/x.md", WRITER, WRITER, exists)).toBe("todo/x.md");
		const kept = "abs /r/todo/x.md, https://h/todo/x.md, seq:a1c9fe4e/4, path:a1c9fe4e/todo/x.md\n```\ncat todo/x.md\n```";
		expect(qualifyPathsFor(kept, WRITER, READER, exists)).toBe(kept);
	});
});

describe("qualifyPathsFor and code", () => {
	const exists = (p: string) => p === "src/app.test.ts" || p === "todo/x.md";

	it("keeps a command in inline code runnable, but converts a span that is one whole path", () => {
		expect(qualifyPathsFor("run `bun test src/app.test.ts` then read `todo/x.md`", WRITER, READER, exists))
			.toBe("run `bun test src/app.test.ts` then read `path:a1c9fe4e/todo/x.md`");
	});

	it("skips indented fences and only closes on a bare fence line", () => {
		const text = "- step:\n    ```sh\n    cat todo/x.md\n    ```js\n    cat todo/x.md\n    ```\nthen todo/x.md";
		expect(qualifyPathsFor(text, WRITER, READER, exists)).toBe(text.replace(/then todo\/x\.md$/, "then path:a1c9fe4e/todo/x.md"));
	});

	it("drops a :col tail in prose too, so no ':5' sticks to the chip", () => {
		expect(qualifyPathsFor("at todo/x.md:12:5, then", WRITER, READER, exists)).toBe("at path:a1c9fe4e/todo/x.md:12, then");
		expect(qualifyPathsFor("at todo/x.md:012 now", WRITER, READER, exists)).toBe("at path:a1c9fe4e/todo/x.md:12 now");
	});

	it("drops a :col inside a whole-path code span, so the span stays one token", () => {
		expect(qualifyPathsFor("see `todo/x.md:12:5`", WRITER, READER, exists)).toBe("see `path:a1c9fe4e/todo/x.md:12`");
	});

	it("does not read a backtick line with more backticks as a fence", () => {
		expect(qualifyPathsFor("```foo``` then todo/x.md", WRITER, READER, exists)).toBe("```foo``` then path:a1c9fe4e/todo/x.md");
	});
});

describe("annotatePathRefs", () => {
	it("adds the absolute path once, and skips a token that names nothing", () => {
		const resolve = (ref: { path: string }) => (ref.path === "todo/x.md" ? "/r/todo/x.md" : null);
		const once = annotatePathRefs("read path:a1c9fe4e/todo/x.md:2 and path:a1c9fe4e/gone.md", resolve);
		expect(once).toBe("read path:a1c9fe4e/todo/x.md:2 (/r/todo/x.md:2) and path:a1c9fe4e/gone.md");
		expect(annotatePathRefs(once, resolve)).toBe(once);
	});

	it("keeps an author's own parenthetical after a token", () => {
		const text = "see path:a1c9fe4e/src/routes.ts (/users endpoint)";
		expect(stripPathAnnotations(text, () => "/r/src/routes.ts")).toBe(text);
		expect(annotatePathRefs(text, () => "/r/src/routes.ts")).toBe("see path:a1c9fe4e/src/routes.ts (/r/src/routes.ts) (/users endpoint)");
	});

	it("strips an annotation whose path holds parentheses", () => {
		const abs = "C:\\Program Files (x86)\\p\\x.md";
		expect(stripPathAnnotations(`a path:a1c9fe4e/x.md (${abs}) b`, () => abs)).toBe("a path:a1c9fe4e/x.md b");
	});

	it("leaves fenced code untouched, so a command in it still runs", () => {
		const text = "```\ncat path:a1c9fe4e/todo/x.md\n```";
		expect(annotatePathRefs(text, () => "/r/todo/x.md")).toBe(text);
	});

	it("stops adding paths at its character budget", () => {
		const text = Array.from({ length: 20 }, (_, i) => `path:a1c9fe4e/f${i}.md`).join(" ");
		const out = annotatePathRefs(text, () => `/${"x".repeat(100)}`, LAUNCH_ANNOTATION_MAX_ADDED_CHARS);
		expect(out.length - text.length).toBeLessThanOrEqual(LAUNCH_ANNOTATION_MAX_ADDED_CHARS);
		expect(out.length).toBeGreaterThan(text.length);
	});

	it("is undone by stripPathAnnotations, in prose and after a code span", () => {
		const text = "a path:a1c9fe4e/todo/x.md:2 and `path:a1c9fe4e/todo/x.md` and (not this)";
		const resolve = () => "C:\\r\\todo\\x.md";
		expect(stripPathAnnotations(annotatePathRefs(text, resolve), resolve)).toBe(text);
	});

	it("puts the path after a code span, not inside it", () => {
		const code = annotatePathRefs("see `path:a1c9fe4e/todo/x.md`.", () => "/r/todo/x.md");
		expect(code).toBe("see `path:a1c9fe4e/todo/x.md` (/r/todo/x.md).");
		expect(annotatePathRefs(code, () => "/r/todo/x.md")).toBe(code);
	});
});

describe("resolving a token on Windows and POSIX hosts", () => {
	const projects = [
		{ id: WRITER, name: "AI-Work", path: "C:\\Users\\me\\AI-Work" },
		{ id: READER, name: "Other", path: "/home/me/other" },
	];

	it("joins with the host's separator", () => {
		expect(resolvePathRefIn(projects, { project: "a1c9fe4e", path: "todo/x.md" }, win32)).toBe("C:\\Users\\me\\AI-Work\\todo\\x.md");
		expect(resolvePathRefIn(projects, { project: "Other", path: "src/a.ts" }, posix)).toBe("/home/me/other/src/a.ts");
	});

	it("refuses an unknown or ambiguous qualifier", () => {
		expect(resolvePathRefIn(projects, { project: "zzzz", path: "a.md" }, posix)).toBeNull();
		expect(resolvePathRefIn([...projects, { id: "a1c9ffff", name: "x", path: "/x" }], { project: "a1c9", path: "a.md" }, posix)).toBeNull();
	});

	it("keeps the result inside the project root on both hosts", () => {
		expect(underRoot("C:\\p", "a/..\\..\\x", win32)).toBeNull();
		expect(underRoot("C:\\p", "a\\b.md", win32)).toBe("C:\\p\\a\\b.md");
		expect(underRoot("/p", "a/b.md", posix)).toBe("/p/a/b.md");
		expect(underRoot("/p-other", "x", posix)).toBe("/p-other/x");
		expect(underRoot("/p", "../p-other/x", posix)).toBeNull();
	});
});
