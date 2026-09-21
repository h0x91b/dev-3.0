import { describe, expect, it, vi } from "vitest";
import { createDeepLinkProvider } from "../terminal-deep-links";
import type { CellLine } from "../terminal-file-links";

/** Same cell semantics as the file-path provider's fixture: one cell per char, 0 for blanks. */
function makeCellLine(spec: string, cols: number, isWrapped = false): CellLine {
	const codes: number[] = [];
	for (const ch of spec) codes.push(ch.codePointAt(0)!);
	while (codes.length < cols) codes.push(0);
	return {
		isWrapped,
		length: cols,
		getCell: (x) => (x < codes.length ? { getCode: () => codes[x] } : undefined),
	};
}

function makeTerm(rows: Array<{ spec: string; cols: number; isWrapped?: boolean }>) {
	const lines = rows.map((row) => makeCellLine(row.spec, row.cols, row.isWrapped ?? false));
	return { buffer: { active: { getLine: (y: number) => lines[y] } } } as never;
}

function linksOn(provider: ReturnType<typeof createDeepLinkProvider>, y: number) {
	let links: Array<{ text: string; range: { start: { x: number }; end: { x: number } }; activate(e: MouseEvent): void }> | undefined;
	provider.provideLinks(y, (result) => {
		links = result as never;
	});
	return links;
}

const TASK_URL = "dev3://task/a21540d6-4890-426f-81c1-41cfc460715e";

describe("createDeepLinkProvider", () => {
	it("linkifies a bare task link and covers exactly its columns", () => {
		const provider = createDeepLinkProvider({
			term: makeTerm([{ spec: `see ${TASK_URL} now`, cols: 80 }]),
			onActivate: vi.fn(),
		});
		const links = linksOn(provider, 0);
		expect(links).toHaveLength(1);
		expect(links![0].text).toBe(TASK_URL);
		expect(links![0].range.start.x).toBe(4);
		expect(links![0].range.end.x).toBe(4 + TASK_URL.length - 1);
	});

	it("activates only with Cmd/Ctrl held", () => {
		const onActivate = vi.fn();
		const provider = createDeepLinkProvider({
			term: makeTerm([{ spec: TASK_URL, cols: 60 }]),
			onActivate,
		});
		const links = linksOn(provider, 0)!;
		links[0].activate({ ctrlKey: false, metaKey: false } as MouseEvent);
		expect(onActivate).not.toHaveBeenCalled();
		links[0].activate({ ctrlKey: false, metaKey: true } as MouseEvent);
		expect(onActivate).toHaveBeenCalledWith(TASK_URL, expect.anything());
	});

	it("stitches a link wrapped across two rows into one target", () => {
		const provider = createDeepLinkProvider({
			term: makeTerm([
				{ spec: "dev3://task/a21540d6", cols: 20 },
				{ spec: "-4890-426f-81c1-41cf", cols: 20, isWrapped: true },
				{ spec: "c460715e", cols: 20, isWrapped: true },
			]),
			onActivate: vi.fn(),
		});
		// One ILink per row the link covers, all pointing at the whole URL.
		const links = linksOn(provider, 0)!;
		expect(links.map((l) => l.text)).toEqual([TASK_URL, TASK_URL, TASK_URL]);
	});

	it("ignores an unknown kind and any other scheme", () => {
		const provider = createDeepLinkProvider({
			term: makeTerm([{ spec: "dev3://bogus/x https://example.com file:///tmp/a.ts", cols: 80 }]),
			onActivate: vi.fn(),
		});
		expect(linksOn(provider, 0)).toBeUndefined();
	});

	it("linksForRows dedupes the ranges a wrapped link contributes per row", () => {
		const provider = createDeepLinkProvider({
			term: makeTerm([
				{ spec: "dev3://task/abcdefgh", cols: 20 },
				{ spec: "ijkl", cols: 20, isWrapped: true },
			]),
			onActivate: vi.fn(),
		});
		const ranges = provider.linksForRows([0, 1]);
		expect(ranges.map((r) => [r.start.y, r.start.x, r.end.x])).toEqual([
			[0, 0, 19],
			[1, 0, 3],
		]);
	});
});
