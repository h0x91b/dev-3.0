import { describe, expect, it } from "vitest";
import { findPathCandidates, isRootedPathText, pathBaseName } from "../../shared/path-candidates";

const paths = (text: string) => findPathCandidates(text).map((c) => c.cleanPath);

describe("findPathCandidates on every platform's spelling", () => {
	it("finds Windows drive paths with either separator", () => {
		expect(paths("saved to C:\\Users\\me\\proj\\notes.md today")).toEqual(["C:\\Users\\me\\proj\\notes.md"]);
		expect(paths("saved to C:/Users/me/proj/notes.md")).toEqual(["C:/Users/me/proj/notes.md"]);
	});

	it("finds backslash-relative paths and keeps a line suffix", () => {
		const [found] = findPathCandidates("error in src\\app.ts:12.");
		expect(found).toMatchObject({ cleanPath: "src\\app.ts", line: 12, raw: "src\\app.ts:12" });
		expect(paths("see .\\docs\\guide.md and ..\\other\\x.txt")).toEqual([".\\docs\\guide.md", "..\\other\\x.txt"]);
	});

	it("does not read a URL scheme as a drive letter", () => {
		expect(paths("open https://foo.com/bar/baz.html now").some((p) => p.startsWith("s:"))).toBe(false);
	});

	it("keeps finding POSIX paths", () => {
		expect(paths("see /Users/me/a.ts, ~/notes/todo.md and src/x.ts")).toEqual(["/Users/me/a.ts", "~/notes/todo.md", "src/x.ts"]);
	});
});

describe("path text helpers", () => {
	it("recognises rooted paths on every platform", () => {
		for (const p of ["/x/y", "~/x", "~\\x", "C:\\x", "c:/x", "\\\\server\\share\\x"]) expect(isRootedPathText(p)).toBe(true);
		for (const p of ["x/y", "todo\\x.md", "C:foo", "./x"]) expect(isRootedPathText(p)).toBe(false);
	});

	it("takes the last segment across separators", () => {
		expect(pathBaseName("C:\\Users\\me\\plan.md")).toBe("plan.md");
		expect(pathBaseName("/home/me/docs/")).toBe("docs");
	});
});
