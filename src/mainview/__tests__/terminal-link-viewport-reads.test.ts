// Counts full-screen WASM copies on the REAL ghostty-web terminal. Array-backed
// buffer mocks make every row read free, which is how a repaint that copied the
// whole screen once per row (2 × 70 copies at 221×70, #1962) went unnoticed.
import { init, Terminal } from "ghostty-web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installBidiRender } from "../terminal-bidi/proxy";
import { createDeepLinkProvider } from "../terminal-deep-links";
import { createFilePathLinkProvider, type BufferRange } from "../terminal-file-links";
import { sharedScanLinks } from "../terminal-link-underlines";

const COLS = 100;
const ROWS = 30;
const LONG_PATH = `/work/${Array.from({ length: 14 }, (_, i) => `segment-${i}`).join("/")}/final.ts`;
const DEEP_LINK = "dev3://task/aade54c6-ff41-42ec-a904-2e5184b18ab0";

function stubCanvas(): void {
	const metrics = { width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3, fontBoundingBoxAscent: 11, fontBoundingBoxDescent: 3 };
	const fake = new Proxy({} as Record<PropertyKey, unknown>, {
		get: (target, key) => {
			if (key in target) return target[key];
			if (key === "measureText") return () => metrics;
			if (key === "getImageData" || key === "createImageData") return () => ({ data: new Uint8ClampedArray(4) });
			return () => {};
		},
		set: (target, key, value) => {
			target[key] = value;
			return true;
		},
	});
	(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => fake;
}

const open: Terminal[] = [];

function openTerminal() {
	const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000 });
	term.open(document.body.appendChild(document.createElement("div")));
	open.push(term);
	const wasm = term.wasmTerm!;
	const real = wasm.getViewport.bind(wasm);
	const reads = { count: 0 };
	wasm.getViewport = () => {
		reads.count += 1;
		return real();
	};
	const write = (data: string) => new Promise<void>((done) => term.write(data, () => done()));
	return { term, reads, write };
}

function providers(term: Terminal) {
	const filePaths = createFilePathLinkProvider({
		term,
		resolvePaths: async (paths) => Object.fromEntries(paths.map((p) => [p, p.includes("/") ? { path: p, kind: "file" as const } : null])),
		onActivate: () => {},
	});
	const deepLinks = createDeepLinkProvider({ term, onActivate: () => {} });
	return { filePaths, deepLinks };
}

function screenRows(term: Terminal): number[] {
	const scrollback = term.buffer.active.length - term.rows;
	return Array.from({ length: term.rows }, (_, row) => scrollback + row);
}

const vendorProviders = new WeakMap<Terminal, ReturnType<typeof providers>>();

/** The same links read through the vendor's own per-row `getLine`, as before #1962. */
function vendorPathLinks(term: Terminal, ys: number[]): BufferRange[] {
	let pair = vendorProviders.get(term);
	if (!pair) {
		// No `wasmTerm`: every row goes through `buffer.active.getLine`.
		pair = providers({ buffer: term.buffer } as Terminal);
		vendorProviders.set(term, pair);
	}
	return [...pair.filePaths.linksForRows(ys), ...pair.deepLinks.linksForRows(ys)];
}

const key = (r: BufferRange) => `${r.start.y}:${r.start.x}-${r.end.y}:${r.end.x}`;

async function fillScreen(write: (data: string) => Promise<void>, lines = ROWS) {
	for (let i = 0; i < lines; i++) {
		const kind = i % 4;
		if (kind === 0) await write(`  read src/mainview/file-${i}.ts:${i} and moved on\r\n`);
		else if (kind === 1) await write(`  ${LONG_PATH}\r\n`); // wider than COLS: soft-wraps
		else if (kind === 2) await write(`open ${DEEP_LINK} to review\r\n`);
		else await write(`plain prose with no links at all, line ${i}\r\n`);
	}
}

/** Resolve every candidate once, so the scans below see links, not just queued lookups. */
async function warm(feed: (ys: number[]) => BufferRange[], ys: number[]) {
	feed(ys);
	await new Promise((r) => setTimeout(r, 40));
}

beforeAll(async () => {
	await init();
	stubCanvas();
});

afterEach(() => {
	for (const term of open.splice(0)) term.dispose();
});

describe("link underline scans on the real terminal", () => {
	it("copies the screen once per repaint for both providers together", async () => {
		const { term, reads, write } = openTerminal();
		await fillScreen(write, ROWS * 2);
		const { filePaths, deepLinks } = providers(term);
		const feed = sharedScanLinks(term, [filePaths, deepLinks]);
		await warm(feed, screenRows(term));

		reads.count = 0;
		const ranges = feed(screenRows(term));
		expect(reads.count).toBe(1);
		expect(ranges.length).toBeGreaterThan(10);
	});

	it("finds exactly the links the vendor's per-row reads find, wrapped paths and deep links included", async () => {
		const { term, write } = openTerminal();
		await fillScreen(write, ROWS * 2);
		const { filePaths, deepLinks } = providers(term);
		const feed = sharedScanLinks(term, [filePaths, deepLinks]);
		await warm(feed, screenRows(term));
		await warm((ys) => vendorPathLinks(term, ys), screenRows(term));

		const ours = feed(screenRows(term));
		// A wrapped path is one link split across two rows of the screen.
		const wrapped = ours.filter((r) => r.start.x === 0 && r.end.x > 10);
		expect(wrapped.length).toBeGreaterThan(0);
		expect(ours.map(key).sort()).toEqual(vendorPathLinks(term, screenRows(term)).map(key).sort());
	});

	it("still reads scrollback rows one by one and the screen once when scrolled up", async () => {
		const { term, reads, write } = openTerminal();
		await fillScreen(write, ROWS * 3);
		const { filePaths, deepLinks } = providers(term);
		const feed = sharedScanLinks(term, [filePaths, deepLinks]);
		term.scrollLines(-10);
		const scrollback = term.buffer.active.length - term.rows;
		// The rows the overlay asks for at viewportY 10: ten from scrollback, the rest from the screen.
		const ys = Array.from({ length: term.rows }, (_, row) => scrollback - 10 + row);
		await warm(feed, ys);
		await warm((rows) => vendorPathLinks(term, rows), ys);

		reads.count = 0;
		const ours = feed(ys);
		expect(reads.count).toBe(1);
		expect(ours.some((r) => r.start.y < scrollback)).toBe(true);
		expect(ours.map(key).sort()).toEqual(vendorPathLinks(term, ys).map(key).sort());
	});

	it("reads the alternate screen once and maps its rows from zero", async () => {
		const { term, reads, write } = openTerminal();
		await fillScreen(write, ROWS * 2);
		await write("\x1b[?1049h\x1b[H");
		await fillScreen(write, ROWS - 1);
		expect(term.buffer.active.type).toBe("alternate");
		const { filePaths, deepLinks } = providers(term);
		const feed = sharedScanLinks(term, [filePaths, deepLinks]);
		const ys = screenRows(term);
		expect(ys[0]).toBe(0);
		await warm(feed, ys);
		await warm((rows) => vendorPathLinks(term, rows), ys);

		reads.count = 0;
		const ours = feed(ys);
		expect(reads.count).toBe(1);
		expect(ours.length).toBeGreaterThan(0);
		expect(ours.map(key).sort()).toEqual(vendorPathLinks(term, ys).map(key).sort());
	});

	it("follows a resize: the next scan uses the new geometry", async () => {
		const { term, reads, write } = openTerminal();
		await fillScreen(write, ROWS * 2);
		term.resize(70, 20);
		await fillScreen(write, 20);
		const { filePaths, deepLinks } = providers(term);
		const feed = sharedScanLinks(term, [filePaths, deepLinks]);
		await warm(feed, screenRows(term));
		await warm((rows) => vendorPathLinks(term, rows), screenRows(term));

		reads.count = 0;
		const ours = feed(screenRows(term));
		expect(reads.count).toBe(1);
		expect(ours.every((r) => r.end.x < 70)).toBe(true);
		expect(ours.map(key).sort()).toEqual(vendorPathLinks(term, screenRows(term)).map(key).sort());
	});

	it("sees content written after the previous scan", async () => {
		const { term, write } = openTerminal();
		await fillScreen(write);
		const { filePaths, deepLinks } = providers(term);
		const feed = sharedScanLinks(term, [filePaths, deepLinks]);
		await warm(feed, screenRows(term));
		const before = feed(screenRows(term)).map(key);

		await write(`fresh ${DEEP_LINK} at the bottom\r\n`);
		await warm((rows) => vendorPathLinks(term, rows), screenRows(term));
		const freshRow = term.buffer.active.length - 2;
		const after = feed(screenRows(term));
		expect(after.map(key)).not.toEqual(before);
		expect(after.some((r) => r.start.y === freshRow && r.start.x === 6)).toBe(true);
		expect(after.map(key).sort()).toEqual(vendorPathLinks(term, screenRows(term)).map(key).sort());
	});

	it("answers a hover on one row with a single screen copy", async () => {
		const { term, reads, write } = openTerminal();
		await fillScreen(write);
		const { filePaths, deepLinks } = providers(term);
		const scrollback = term.buffer.active.length - term.rows;
		await warm((ys) => filePaths.linksForRows(ys), screenRows(term));

		reads.count = 0;
		filePaths.provideLinks(scrollback + 1, () => {});
		expect(reads.count).toBe(1);
		reads.count = 0;
		deepLinks.provideLinks(scrollback + 2, () => {});
		expect(reads.count).toBe(1);
	});

	it("exposes the cost it guards: the vendor's per-row path copies the screen once per row", async () => {
		const { term, reads, write } = openTerminal();
		await fillScreen(write);
		reads.count = 0;
		vendorPathLinks(term, screenRows(term));
		// Two providers, each reading every screen row (plus a neighbour) through getLine.
		expect(reads.count).toBeGreaterThanOrEqual(2 * ROWS);
	});
});

describe("bidi render on the real terminal", () => {
	function frame(term: Terminal) {
		const renderer = term.renderer as unknown as {
			render(buffer: unknown, forceAll: boolean, viewportY: number, scrollback: unknown, opacity: number): void;
		};
		renderer.render(term.wasmTerm, false, 0, term, 0);
	}

	it("reads nothing on an idle frame and re-reads once the cursor row changes", async () => {
		const { term, reads, write } = openTerminal();
		installBidiRender(term.renderer as never);
		await write("prompt $ שלום world");
		frame(term);
		frame(term);

		reads.count = 0;
		frame(term);
		frame(term);
		expect(reads.count).toBe(0);

		await write(" more");
		frame(term);
		expect(reads.count).toBe(1);
	});
});
