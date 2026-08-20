import { describe, expect, it, vi } from "vitest";
import {
	createFilePathLinkProvider,
	findPathCandidates,
	getLogicalLines,
	lineToText,
	mapRangeToBuffer,
	type CellLine,
} from "../terminal-file-links";
import type { ResolvedTerminalPath } from "../../shared/types";

describe("findPathCandidates", () => {
	it("finds absolute paths", () => {
		const found = findPathCandidates("saved to /Users/me/project/src/index.ts today");
		expect(found).toHaveLength(1);
		expect(found[0].cleanPath).toBe("/Users/me/project/src/index.ts");
		expect(found[0].start).toBe(9);
	});

	it("finds relative paths with slashes", () => {
		const found = findPathCandidates("Draft is ready at kb-playbook-drafts/waf-cve-virtual-patching.md, built from");
		expect(found).toHaveLength(1);
		expect(found[0].cleanPath).toBe("kb-playbook-drafts/waf-cve-virtual-patching.md");
	});

	it("finds ~, ./ and ../ prefixed paths", () => {
		expect(findPathCandidates("see ~/notes/todo.md")[0]?.cleanPath).toBe("~/notes/todo.md");
		expect(findPathCandidates("see ./src/app.ts")[0]?.cleanPath).toBe("./src/app.ts");
		expect(findPathCandidates("see ../other/file.txt")[0]?.cleanPath).toBe("../other/file.txt");
	});

	it("finds bare filenames with an extension", () => {
		const found = findPathCandidates("update package.json and README.md please");
		expect(found.map((c) => c.cleanPath)).toEqual(["package.json", "README.md"]);
	});

	it("keeps :line:col in raw, strips it from cleanPath, and parses the line", () => {
		const found = findPathCandidates("error at src/foo.ts:12:5 in build");
		expect(found).toHaveLength(1);
		expect(found[0].raw).toBe("src/foo.ts:12:5");
		expect(found[0].cleanPath).toBe("src/foo.ts");
		expect(found[0].line).toBe(12);
		expect(found[0].end).toBe(found[0].start + "src/foo.ts:12:5".length - 1);
	});

	it("strips trailing sentence punctuation", () => {
		const found = findPathCandidates("look at src/app.ts.");
		expect(found[0].cleanPath).toBe("src/app.ts");
		const parenthesized = findPathCandidates("(see docs/guide.md)");
		expect(parenthesized[0].cleanPath).toBe("docs/guide.md");
	});

	it("does not match inside URLs", () => {
		const found = findPathCandidates("open https://foo.com/bar/baz.html now");
		expect(found.filter((c) => c.cleanPath.includes("foo.com"))).toHaveLength(0);
	});

	it("ignores pure numbers and too-short tokens", () => {
		expect(findPathCandidates("version 3.5 costs 1,000.50")).toHaveLength(0);
	});
});

/**
 * Real ghostty cell semantics: a row is exactly `cols` cells; unwritten cells
 * have codepoint 0. `spec` maps each character to one cell; "␀" marks an
 * explicit codepoint-0 gap and astral chars occupy TWO cells (glyph + spacer 0).
 */
function makeCellLine(spec: string, cols: number, isWrapped = false): CellLine {
	const codes: number[] = [];
	for (const ch of spec) {
		const code = ch === "␀" ? 0 : ch.codePointAt(0)!;
		codes.push(code);
		if (code > 0xffff) codes.push(0); // wide-char spacer cell
	}
	while (codes.length < cols) codes.push(0);
	return {
		isWrapped,
		length: cols,
		getCell: (x) => (x < codes.length ? { getCode: () => codes[x] } : undefined),
	};
}

function fakeBuffer(rows: Array<{ spec: string; cols: number; isWrapped?: boolean }>) {
	const lines = rows.map((row) => makeCellLine(row.spec, row.cols, row.isWrapped ?? false));
	return (y: number) => lines[y];
}

describe("lineToText", () => {
	it("emits exactly one UTF-16 unit per cell, blanks as spaces", () => {
		const text = lineToText(makeCellLine("ab␀cd", 8));
		expect(text).toBe("ab cd   ");
		expect(text.length).toBe(8);
	});

	it("keeps columns aligned after an astral emoji (glyph + spacer → two spaces)", () => {
		// 🎉 is astral: its glyph cell and spacer cell both become spaces.
		const line = makeCellLine("🎉 x.md", 10);
		const text = lineToText(line);
		expect(text.length).toBe(10);
		expect(text.indexOf("x.md")).toBe(3); // cell-exact column, not string-shifted
	});
});

describe("getLogicalLines", () => {
	it("returns cell-exact text for a single row", () => {
		const getLine = fakeBuffer([{ spec: "hello world", cols: 16 }]);
		const [logical] = getLogicalLines(getLine, 0);
		expect(logical?.text).toBe("hello world     ");
		expect(logical?.rows).toHaveLength(1);
	});

	it("stitches wrapped rows and maps offsets to exact cells", () => {
		// A path soft-wrapped across two 20-col rows.
		const getLine = fakeBuffer([
			{ spec: "saved kb-playbook-dr", cols: 20 },
			{ spec: "afts/waf.md ok", cols: 20, isWrapped: true },
		]);
		const [logical] = getLogicalLines(getLine, 1);
		expect(logical?.text.startsWith("saved kb-playbook-drafts/waf.md ok")).toBe(true);
		expect(logical?.rows.map((r) => r.offset)).toEqual([0, 20]);

		const candidates = findPathCandidates(logical!.text);
		expect(candidates[0].cleanPath).toBe("kb-playbook-drafts/waf.md");
		// One segment per row, so hit-testing and underlines stay column-exact.
		expect(mapRangeToBuffer(logical!.rows, candidates[0].start, candidates[0].end)).toEqual([
			{ start: { x: 6, y: 0 }, end: { x: 19, y: 0 } },
			{ start: { x: 0, y: 1 }, end: { x: 10, y: 1 } },
		]);
	});

	it("stitches a full row into the next one when the wrap flag is missing", () => {
		// tmux redraws a split pane row by row: no wrap flag ever arrives.
		const getLine = fakeBuffer([
			{ spec: "log /Users/me/deep/di", cols: 21 },
			{ spec: "rs/notes.md written", cols: 21 },
		]);
		const [logical] = getLogicalLines(getLine, 0);
		const [candidate] = findPathCandidates(logical!.text);
		expect(candidate.cleanPath).toBe("/Users/me/deep/dirs/notes.md");
		expect(mapRangeToBuffer(logical!.rows, candidate.start, candidate.end)).toEqual([
			{ start: { x: 4, y: 0 }, end: { x: 20, y: 0 } },
			{ start: { x: 0, y: 1 }, end: { x: 10, y: 1 } },
		]);
	});

	it("does not stitch when the row stops well short of the band's last column", () => {
		const getLine = fakeBuffer([
			{ spec: "prose that ends here", cols: 30 },
			{ spec: "next line starts here", cols: 30 },
		]);
		const [logical] = getLogicalLines(getLine, 0);
		expect(logical?.rows).toHaveLength(1);
	});

	it("stitches an indented continuation row, dropping padding and indent", () => {
		// Claude Code reflows its own output: a real newline plus an indent, and
		// the break lands a couple of columns short of the true right edge.
		const getLine = fakeBuffer([
			{ spec: "  156 /Users/me/deep/di", cols: 25 },
			{ spec: "      rs/notes.md done", cols: 25 },
		]);
		const [logical] = getLogicalLines(getLine, 0);
		const [candidate] = findPathCandidates(logical!.text);
		expect(candidate.cleanPath).toBe("/Users/me/deep/dirs/notes.md");
		expect(mapRangeToBuffer(logical!.rows, candidate.start, candidate.end)).toEqual([
			{ start: { x: 6, y: 0 }, end: { x: 22, y: 0 } },
			{ start: { x: 6, y: 1 }, end: { x: 16, y: 1 } },
		]);
	});

	it("does not stitch a deeply indented row onto the one above", () => {
		const getLine = fakeBuffer([
			{ spec: "note /Users/me/deep/di", cols: 22 },
			{ spec: "              rs/notes.md", cols: 22 },
		]);
		const [logical] = getLogicalLines(getLine, 0);
		expect(logical?.rows).toHaveLength(1);
	});

	it("keeps each tmux pane in its own band and stitches inside it", () => {
		// 41 cols: left pane 0-19, border at 20, right pane 21-40.
		const gap = (n: number) => "␀".repeat(n);
		const getLine = fakeBuffer([
			{ spec: `left a/one.ts here${gap(2)}│right /tmp/deep/dirs`, cols: 41 },
			{ spec: `left tail${gap(11)}│/notes.md done`, cols: 41 },
		]);
		const lines = getLogicalLines(getLine, 0);
		expect(lines).toHaveLength(2);
		expect(lines[0].rows).toHaveLength(1); // left pane row does not fill its band
		expect(lines[1].text).toBe("right /tmp/deep/dirs/notes.md done      ");
		const [candidate] = findPathCandidates(lines[1].text);
		expect(candidate.cleanPath).toBe("/tmp/deep/dirs/notes.md");
		expect(mapRangeToBuffer(lines[1].rows, candidate.start, candidate.end)).toEqual([
			{ start: { x: 27, y: 0 }, end: { x: 40, y: 0 } },
			{ start: { x: 21, y: 1 }, end: { x: 29, y: 1 } },
		]);
	});

	it("maps columns exactly on a row with a codepoint-0 gap before the path", () => {
		// Cursor-positioned output: cells 0-3 written, gap of unwritten cells,
		// then the path at a known column.
		const getLine = fakeBuffer([{ spec: "err:␀␀␀␀src/a.ts", cols: 24 }]);
		const [logical] = getLogicalLines(getLine, 0);
		const [candidate] = findPathCandidates(logical.text);
		expect(candidate.cleanPath).toBe("src/a.ts");
		const [segment] = mapRangeToBuffer(logical.rows, candidate.start, candidate.end);
		expect(segment.start).toEqual({ x: 8, y: 0 }); // true screen column
		expect(segment.end).toEqual({ x: 15, y: 0 });
	});

	it("starts from the requested row when it is not wrapped", () => {
		const getLine = fakeBuffer([
			{ spec: "first line", cols: 20 },
			{ spec: "second /tmp/x.txt", cols: 20 },
		]);
		const [logical] = getLogicalLines(getLine, 1);
		expect(logical?.rows[0].y).toBe(1);
	});
});

function makeTerm(rows: Array<{ spec: string; cols: number; isWrapped?: boolean }>) {
	const getLine = fakeBuffer(rows);
	return { buffer: { active: { getLine } } } as never;
}

async function settle() {
	// Background resolve flushes on a 16ms timer.
	await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("createFilePathLinkProvider", () => {
	it("answers synchronously; fresh candidates resolve in the background", async () => {
		const resolvePaths = vi.fn(async (paths: string[]) => {
			const out: Record<string, ResolvedTerminalPath | null> = {};
			for (const p of paths) {
				out[p] = p === "src/real.ts" ? { path: "/wt/src/real.ts", kind: "file" } : null;
			}
			return out;
		});
		const onResolutionsChanged = vi.fn();
		const provider = createFilePathLinkProvider({
			term: makeTerm([{ spec: "see src/real.ts and src/fake.ts", cols: 40 }]),
			resolvePaths,
			onActivate: vi.fn(),
			onResolutionsChanged,
		});

		// First, synchronous answer: nothing cached yet.
		let sync: unknown[] | undefined = [];
		provider.provideLinks(0, (links) => {
			sync = links as never;
		});
		expect(sync).toBeUndefined();

		await settle();
		expect(onResolutionsChanged).toHaveBeenCalled();
		// Both candidates went out in ONE batched RPC.
		expect(resolvePaths).toHaveBeenCalledTimes(1);
		expect(resolvePaths.mock.calls[0][0].sort()).toEqual(["src/fake.ts", "src/real.ts"]);

		// Second lookup answers synchronously from the cache.
		let cached: Array<{ text: string }> | undefined;
		provider.provideLinks(0, (links) => {
			cached = links as never;
		});
		expect(cached).toHaveLength(1);
		expect(cached![0].text).toBe("src/real.ts");
		provider.dispose();
	});

	it("activates only with Cmd/Ctrl held and passes the resolved target + line", async () => {
		const onActivate = vi.fn();
		const target: ResolvedTerminalPath = { path: "/wt/a/b.md", kind: "file" };
		const provider = createFilePathLinkProvider({
			term: makeTerm([{ spec: "open a/b.md:7 now", cols: 30 }]),
			resolvePaths: async () => ({ "a/b.md": target }),
			onActivate,
		});
		provider.provideLinks(0, () => {});
		await settle();
		let links: Array<{ activate(e: MouseEvent): void }> | undefined;
		provider.provideLinks(0, (result) => {
			links = result as never;
		});
		links![0].activate({ ctrlKey: false, metaKey: false } as MouseEvent);
		expect(onActivate).not.toHaveBeenCalled();
		links![0].activate({ ctrlKey: false, metaKey: true } as MouseEvent);
		expect(onActivate).toHaveBeenCalledWith(target, expect.anything(), 7);
		provider.dispose();
	});

	it("linksForRows batches the whole viewport and skips sibling rows of one logical line", async () => {
		const resolvePaths = vi.fn(async (paths: string[]) => {
			const out: Record<string, ResolvedTerminalPath | null> = {};
			for (const p of paths) out[p] = { path: `/wt/${p}`, kind: "file" };
			return out;
		});
		const provider = createFilePathLinkProvider({
			term: makeTerm([
				{ spec: "wrapped path a/very-lo", cols: 22 },
				{ spec: "ng-name.md here", cols: 22, isWrapped: true },
				{ spec: "and b/other.ts too", cols: 22 },
			]),
			resolvePaths,
			onActivate: vi.fn(),
		});
		provider.linksForRows([0, 1, 2]);
		await settle();
		// One RPC for the whole viewport, both candidates in it.
		expect(resolvePaths).toHaveBeenCalledTimes(1);
		expect(resolvePaths.mock.calls[0][0].sort()).toEqual(["a/very-long-name.md", "b/other.ts"]);

		const ranges = provider.linksForRows([0, 1, 2]);
		// The wrapped link contributes one segment per row, each reported once.
		expect(ranges).toHaveLength(3);
		expect(ranges.map((r) => [r.start.y, r.end.y])).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
		]);
		provider.dispose();
	});

	it("keeps each row's own link when a wrong stitch would swallow both", async () => {
		// Two full-width rows that are NOT one wrapped path: the merged token
		// resolves to nothing, so both real paths must still surface per row.
		const resolvePaths = vi.fn(async (paths: string[]) => {
			const out: Record<string, ResolvedTerminalPath | null> = {};
			for (const p of paths) {
				out[p] = p === "src/alpha.ts" || p === "src/omega.ts" ? { path: `/wt/${p}`, kind: "file" } : null;
			}
			return out;
		});
		const provider = createFilePathLinkProvider({
			term: makeTerm([
				{ spec: "run src/alpha.ts", cols: 16 },
				{ spec: "run src/omega.ts", cols: 16 },
			]),
			resolvePaths,
			onActivate: vi.fn(),
		});
		provider.linksForRows([0, 1]);
		await settle();
		const ranges = provider.linksForRows([0, 1]);
		expect(ranges.map((r) => `${r.start.y}:${r.start.x}-${r.end.x}`).sort()).toEqual(["0:4-15", "1:4-15"]);
		provider.dispose();
	});

	it("reports no links for plain prose", () => {
		const provider = createFilePathLinkProvider({
			term: makeTerm([{ spec: "just some words here", cols: 30 }]),
			resolvePaths: async () => ({}),
			onActivate: vi.fn(),
		});
		let links: unknown[] | undefined = [];
		provider.provideLinks(0, (result) => {
			links = result as never;
		});
		expect(links).toBeUndefined();
		provider.dispose();
	});
});
