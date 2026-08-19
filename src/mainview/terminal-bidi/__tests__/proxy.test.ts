import type { GhosttyCell } from "ghostty-web";
import { describe, expect, it, vi } from "vitest";
import { type BidiEngine, defaultBidiEngine } from "../engine";
import {
	createBidiRenderable,
	createBidiScrollback,
	installBidiRender,
	isBidiRenderInstalled,
	uninstallBidiRender,
} from "../proxy";
import { paintedText, row } from "./fixtures";

/** The real engine, with call counters — never a vi.mock of the node_module. */
function spyEngine(): BidiEngine & { levelCalls: () => number } {
	const real = defaultBidiEngine();
	const getEmbeddingLevels = vi.fn(real.getEmbeddingLevels.bind(real));
	return {
		getEmbeddingLevels,
		getReorderSegments: real.getReorderSegments.bind(real),
		getReorderedIndices: real.getReorderedIndices.bind(real),
		getMirroredCharactersMap: real.getMirroredCharactersMap.bind(real),
		getBidiCharTypeName: real.getBidiCharTypeName.bind(real),
		levelCalls: () => getEmbeddingLevels.mock.calls.length,
	};
}

function innerBuffer(rows: GhosttyCell[][], cursor = { x: 0, y: 0, visible: true }) {
	const state = { cursor, dirty: new Set<number>() };
	const calls = { getLine: [] as number[], grapheme: [] as [number, number][] };
	return {
		calls,
		state,
		getLine(y: number) {
			calls.getLine.push(y);
			return rows[y] ?? null;
		},
		getCursor: () => ({ ...state.cursor }),
		getDimensions: () => ({ cols: 80, rows: rows.length }),
		isRowDirty: (y: number) => state.dirty.has(y),
		needsFullRedraw: () => false,
		clearDirty: () => state.dirty.clear(),
		getGraphemeString(rowIndex: number, col: number) {
			calls.grapheme.push([rowIndex, col]);
			return `<${rowIndex}:${col}>`;
		},
	};
}

describe("createBidiRenderable", () => {
	it("returns the vendor's own array for a row with nothing to reorder", () => {
		const latin = row("ls -la");
		const inner = innerBuffer([latin]);
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();

		expect(proxy.getLine(0)).toBe(latin);
	});

	it("returns cells in visual order for a right-to-left row", () => {
		const inner = innerBuffer([row("abc שלום")]);
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();

		expect(paintedText(proxy.getLine(0) ?? [])).toBe("abc םולש");
	});

	it("passes a missing row straight through", () => {
		const proxy = createBidiRenderable(innerBuffer([]));
		proxy.beginFrame();
		expect(proxy.getLine(5)).toBeNull();
	});

	it("maps a grapheme lookup's visual column back to its logical column", () => {
		const inner = innerBuffer([row("שלום")]);
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();
		proxy.getLine(0);

		expect(proxy.getGraphemeString?.(0, 0)).toBe("<0:3>");
		expect(proxy.getGraphemeString?.(0, 3)).toBe("<0:0>");
	});

	it("drops the mapping when the next row takes the fast path", () => {
		const inner = innerBuffer([row("שלום"), row("emoji")]);
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();

		proxy.getLine(0);
		proxy.getLine(1);
		// Row 1 must not inherit row 0's mapping.
		expect(proxy.getGraphemeString?.(1, 0)).toBe("<1:0>");
	});

	it("does not remap a lookup for a row other than the one just produced", () => {
		const inner = innerBuffer([row("שלום"), row("שלום")]);
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();

		proxy.getLine(1);
		expect(proxy.getGraphemeString?.(0, 0)).toBe("<0:0>");
	});

	it("reports the cursor in visual coordinates", () => {
		const inner = innerBuffer([row("שלום")], { x: 0, y: 0, visible: true });
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();

		expect(proxy.getCursor()).toEqual({ x: 3, y: 0, visible: true });
	});

	it("reorders the cursor's row itself, since getCursor runs before any getLine", () => {
		const inner = innerBuffer([row("שלום")], { x: 1, y: 0, visible: true });
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();

		// No getLine has happened yet — a "last row seen" cache would lag a frame.
		expect(proxy.getCursor().x).toBe(2);
	});

	it("reorders the cursor's row exactly once per frame", () => {
		const engine = spyEngine();
		const inner = innerBuffer([row("שלום"), row("שלום")], { x: 0, y: 0, visible: true });
		const proxy = createBidiRenderable(inner, engine);

		proxy.beginFrame();
		proxy.getCursor();
		proxy.getLine(0);
		proxy.getLine(1);
		expect(engine.levelCalls()).toBe(2);
	});

	it("hands the render loop the same reordered array it built for the cursor row", () => {
		const inner = innerBuffer([row("שלום")], { x: 0, y: 0, visible: true });
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();

		proxy.getCursor();
		const first = proxy.getLine(0);
		expect(proxy.getLine(0)).toBe(first);
	});

	it("picks up new row content on the next frame", () => {
		const rows = [row("שלום")];
		const inner = innerBuffer(rows, { x: 0, y: 0, visible: true });
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		proxy.getCursor();

		rows[0] = row("hello");
		proxy.beginFrame();
		expect(proxy.getCursor().x).toBe(0);
		expect(proxy.getLine(0)).toBe(rows[0]);
	});

	it("forces a repaint when a logical cursor move keeps the same visual column", () => {
		// Typing Hebrew: the cursor advances logically while the growing run pushes
		// the same visual column back under it. The renderer compares visual x only,
		// so without this the cursor would silently stop moving.
		const rows = [row("אב")];
		const inner = innerBuffer(rows, { x: 0, y: 0, visible: true });
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		expect(proxy.getCursor().x).toBe(1);
		expect(proxy.isRowDirty(0)).toBe(false);

		rows[0] = row("אבג");
		inner.state.cursor = { x: 1, y: 0, visible: true };
		proxy.beginFrame();
		expect(proxy.getCursor().x).toBe(1);
		expect(proxy.isRowDirty(0)).toBe(true);
	});

	it("does not force a repaint when the visual column really moved", () => {
		const inner = innerBuffer([row("שלום")], { x: 0, y: 0, visible: true });
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		expect(proxy.getCursor().x).toBe(3);
		expect(proxy.isRowDirty(0)).toBe(false);

		inner.state.cursor = { x: 1, y: 0, visible: true };
		proxy.beginFrame();
		expect(proxy.getCursor().x).toBe(2);
		expect(proxy.isRowDirty(0)).toBe(false);
	});

	it("keeps a cursor past the end of the row where it is", () => {
		const inner = innerBuffer([row("שלום")], { x: 40, y: 0, visible: true });
		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();
		expect(proxy.getCursor().x).toBe(40);
	});

	it("passes dimensions, dirty state and full-redraw through", () => {
		const inner = innerBuffer([row("abc")]);
		const proxy = createBidiRenderable(inner);

		expect(proxy.getDimensions()).toEqual({ cols: 80, rows: 1 });
		expect(proxy.isRowDirty(0)).toBe(false);
		inner.state.dirty.add(0);
		expect(proxy.isRowDirty(0)).toBe(true);
		expect(proxy.needsFullRedraw?.()).toBe(false);

		proxy.clearDirty();
		expect(inner.state.dirty.size).toBe(0);
	});

	it("omits optional methods the buffer does not have", () => {
		const bare = {
			getLine: () => null,
			getCursor: () => ({ x: 0, y: 0, visible: false }),
			getDimensions: () => ({ cols: 1, rows: 1 }),
			isRowDirty: () => false,
			clearDirty: () => {},
		};
		const proxy = createBidiRenderable(bare);

		expect(proxy.getGraphemeString).toBeUndefined();
		expect(proxy.needsFullRedraw).toBeUndefined();
	});
});

describe("createBidiRenderable — per-frame viewport cache", () => {
	/**
	 * Mimics ghostty-web: `getViewport()` hands back one reusable pool, and
	 * `getLine()` re-reads that whole pool for every single row.
	 */
	function pooledBuffer(rows: GhosttyCell[][], cols = 4) {
		const calls = { viewport: 0, update: 0, getLine: 0 };
		const pool: GhosttyCell[] = [];
		for (const r of rows) for (let x = 0; x < cols; x++) pool.push({ ...r[x] });
		return {
			calls,
			pool,
			update() {
				calls.update += 1;
			},
			getViewport() {
				calls.viewport += 1;
				return pool;
			},
			getLine(y: number) {
				calls.getLine += 1;
				this.update();
				this.getViewport();
				if (y < 0 || y >= rows.length) return null;
				return pool.slice(y * cols, y * cols + cols).map((c) => ({ ...c }));
			},
			getCursor: () => ({ x: 0, y: 0, visible: true }),
			getDimensions: () => ({ cols, rows: rows.length }),
			isRowDirty: () => false,
			clearDirty: () => {},
		};
	}

	const screen = () => [row("abcd"), row("efgh"), row("ijkl")];

	it("reads the whole viewport once per frame, not once per row", () => {
		const inner = pooledBuffer(screen());
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		proxy.getCursor();
		for (let y = 0; y < 3; y++) proxy.getLine(y);

		expect(inner.calls.viewport).toBe(1);
		expect(inner.calls.getLine).toBe(0);
	});

	it("refreshes the render state before reading the pool", () => {
		const inner = pooledBuffer(screen());
		const order: string[] = [];
		const realUpdate = inner.update.bind(inner);
		const realViewport = inner.getViewport.bind(inner);
		inner.update = () => {
			order.push("update");
			realUpdate();
		};
		inner.getViewport = () => {
			order.push("viewport");
			return realViewport();
		};

		const proxy = createBidiRenderable(inner);
		proxy.beginFrame();
		proxy.getLine(0);

		expect(order).toEqual(["update", "viewport"]);
	});

	it("hands back the same cells the vendor's per-row path would", () => {
		const rows = screen();
		const cached = createBidiRenderable(pooledBuffer(rows));
		const uncached = createBidiRenderable(innerBuffer(rows));

		cached.beginFrame();
		uncached.beginFrame();
		for (let y = 0; y < 3; y++) {
			expect(cached.getLine(y)).toEqual(uncached.getLine(y));
		}
	});

	it("copies out of the pool instead of aliasing it", () => {
		const inner = pooledBuffer(screen());
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		const line = proxy.getLine(0);
		inner.pool[0].codepoint = 0x2603;

		expect(line?.[0].codepoint).not.toBe(0x2603);
	});

	it("re-reads the pool on the next frame", () => {
		const inner = pooledBuffer(screen());
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		proxy.getLine(0);
		proxy.beginFrame();
		const second = proxy.getLine(0);

		expect(inner.calls.viewport).toBe(2);
		expect(second?.[0].codepoint).toBe("a".codePointAt(0));
	});

	it("serves the cursor row from the same cache", () => {
		const inner = pooledBuffer(screen());
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		proxy.getCursor();
		proxy.getLine(0);

		expect(inner.calls.viewport).toBe(1);
	});

	it("returns null past the last row, as the vendor does", () => {
		const inner = pooledBuffer(screen());
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		expect(proxy.getLine(-1)).toBeNull();
		expect(proxy.getLine(3)).toBeNull();
	});

	it("falls back to per-row reads when the buffer has no viewport call", () => {
		const inner = innerBuffer(screen());
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		for (let y = 0; y < 3; y++) proxy.getLine(y);

		expect(inner.calls.getLine).toEqual([0, 1, 2]);
	});

	it("falls back for good when the pool is smaller than the screen", () => {
		const inner = pooledBuffer(screen());
		let probes = 0;
		inner.getViewport = () => {
			probes += 1;
			return inner.pool.slice(0, 2);
		};
		// Counted on its own, so the fallback's own reads cannot look like probes.
		inner.getLine = (y: number) => {
			inner.calls.getLine += 1;
			if (y < 0 || y >= 3) return null;
			return inner.pool.slice(y * 4, y * 4 + 4).map((c) => ({ ...c }));
		};
		const proxy = createBidiRenderable(inner);

		proxy.beginFrame();
		expect(proxy.getLine(0)).toEqual(screen()[0]);
		proxy.getLine(1);
		proxy.beginFrame();
		proxy.getLine(2);

		expect(probes).toBe(1);
		expect(inner.calls.getLine).toBe(3);
	});
});

describe("createBidiScrollback", () => {
	it("reorders scrollback rows and passes the length through", () => {
		const history = [row("שלום"), row("plain")];
		const proxy = createBidiScrollback({
			getScrollbackLine: (offset: number) => history[offset] ?? null,
			getScrollbackLength: () => history.length,
		});

		expect(paintedText(proxy.getScrollbackLine(0) ?? [])).toBe("םולש");
		expect(proxy.getScrollbackLine(1)).toBe(history[1]);
		expect(proxy.getScrollbackLine(9)).toBeNull();
		expect(proxy.getScrollbackLength()).toBe(2);
	});
});

describe("installBidiRender", () => {
	function fakeRenderer() {
		const seen: { buffer: unknown; scrollback: unknown; args: unknown[] }[] = [];
		return {
			seen,
			render(
				buffer: Parameters<typeof createBidiRenderable>[0],
				forceAll?: boolean,
				viewportY?: number,
				scrollback?: Parameters<typeof createBidiScrollback>[0],
				opacity?: number,
			) {
				seen.push({ buffer, scrollback, args: [forceAll, viewportY, opacity] });
			},
		};
	}

	it("hands the renderer a visual-order view and forwards every argument", () => {
		const renderer = fakeRenderer();
		const inner = innerBuffer([row("שלום")]);
		const history = { getScrollbackLine: () => null, getScrollbackLength: () => 0 };
		installBidiRender(renderer);

		renderer.render(inner, true, 3, history, 0.5);

		const call = renderer.seen[0];
		expect(call.buffer).not.toBe(inner);
		expect(call.scrollback).not.toBe(history);
		expect(call.args).toEqual([true, 3, 0.5]);
		expect(paintedText((call.buffer as typeof inner).getLine(0) ?? [])).toBe("םולש");
	});

	it("leaves a missing scrollback provider missing", () => {
		const renderer = fakeRenderer();
		installBidiRender(renderer);

		renderer.render(innerBuffer([row("abc")]), false, 0, undefined, 1);
		expect(renderer.seen[0].scrollback).toBeUndefined();
	});

	it("reuses the same view across frames so the cursor memo survives", () => {
		const renderer = fakeRenderer();
		const inner = innerBuffer([row("abc")]);
		installBidiRender(renderer);

		renderer.render(inner);
		renderer.render(inner);
		expect(renderer.seen[0].buffer).toBe(renderer.seen[1].buffer);
	});

	it("resets the per-frame cursor memo on every render", () => {
		const engine = spyEngine();
		const renderer = fakeRenderer();
		const inner = innerBuffer([row("שלום")], { x: 0, y: 0, visible: true });
		installBidiRender(renderer, engine);

		renderer.render(inner);
		(renderer.seen[0].buffer as typeof inner).getCursor();
		renderer.render(inner);
		(renderer.seen[1].buffer as typeof inner).getCursor();

		expect(engine.levelCalls()).toBe(2);
	});

	it("is idempotent", () => {
		const renderer = fakeRenderer();
		const original = renderer.render;
		installBidiRender(renderer);
		const wrapped = renderer.render;
		installBidiRender(renderer);

		expect(renderer.render).toBe(wrapped);
		expect(renderer.render).not.toBe(original);
		expect(isBidiRenderInstalled(renderer)).toBe(true);
	});

	it("restores the vendor's own render on uninstall", () => {
		const renderer = fakeRenderer();
		const original = renderer.render;
		installBidiRender(renderer);
		uninstallBidiRender(renderer);

		expect(renderer.render).toBe(original);
		expect(isBidiRenderInstalled(renderer)).toBe(false);

		const inner = innerBuffer([row("שלום")]);
		renderer.render(inner);
		expect(renderer.seen[0].buffer).toBe(inner);
	});

	it("ignores uninstall when nothing is installed", () => {
		const renderer = fakeRenderer();
		const original = renderer.render;
		uninstallBidiRender(renderer);
		expect(renderer.render).toBe(original);
	});
});
