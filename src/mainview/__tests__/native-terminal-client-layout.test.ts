import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createClientPaneLayout,
	focusPane,
	isPaneZoomed,
	reconcileClientPaneLayout,
	toggleZoom,
	unzoomPane,
	validateClientPaneLayout,
	zoomPane,
	type ClientPaneLayout,
} from "../../shared/native-terminal-client-layout";

const cwd = process.cwd();
const mainviewRoot = cwd.endsWith(join("src", "mainview")) ? cwd : resolve(cwd, "src/mainview");
const MODULE_SOURCE = resolve(mainviewRoot, "../shared/native-terminal-client-layout/index.ts");

const STATE_KEYS = ["paneIds", "focusedPaneId", "zoomedPaneId"] as const;

function panes(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `pane-${index + 1}`);
}

describe("createClientPaneLayout", () => {
	it("focuses the first pane and starts unzoomed", () => {
		const layout = createClientPaneLayout(panes(3));
		expect(layout.paneIds).toEqual(["pane-1", "pane-2", "pane-3"]);
		expect(layout.focusedPaneId).toBe("pane-1");
		expect(layout.zoomedPaneId).toBeNull();
	});

	it("has no focus for an empty pane set", () => {
		const layout = createClientPaneLayout([]);
		expect(layout.paneIds).toEqual([]);
		expect(layout.focusedPaneId).toBeNull();
		expect(layout.zoomedPaneId).toBeNull();
	});

	it("drops duplicate and empty ids while preserving first-occurrence order", () => {
		const layout = createClientPaneLayout(["pane-2", "", "pane-1", "pane-2", "pane-1"]);
		expect(layout.paneIds).toEqual(["pane-2", "pane-1"]);
		expect(layout.focusedPaneId).toBe("pane-2");
	});

	it("only exposes the three client-local fields (no PTY dimensions)", () => {
		const layout = createClientPaneLayout(panes(2));
		expect(Object.keys(layout).sort()).toEqual([...STATE_KEYS].sort());
	});
});

describe.each([0, 1, 2, 6])("invariants hold for %i panes", (count) => {
	it("produces a valid layout from create and reconcile", () => {
		const created = createClientPaneLayout(panes(count));
		expect(validateClientPaneLayout(created).valid).toBe(true);
		expect(created.focusedPaneId === null).toBe(count === 0);

		const reconciled = reconcileClientPaneLayout(createClientPaneLayout([]), panes(count));
		expect(validateClientPaneLayout(reconciled).valid).toBe(true);
		expect(reconciled.focusedPaneId).toBe(count === 0 ? null : "pane-1");
	});
});

describe("reconcileClientPaneLayout — focus", () => {
	it("keeps a still-present focus", () => {
		const layout = focusPane(createClientPaneLayout(panes(3)), "pane-2");
		const next = reconcileClientPaneLayout(layout, ["pane-1", "pane-2", "pane-3", "pane-4"]);
		expect(next.focusedPaneId).toBe("pane-2");
	});

	it("moves focus to the next surviving pane when the focused pane is removed", () => {
		const layout = focusPane(createClientPaneLayout(panes(6)), "pane-3");
		const next = reconcileClientPaneLayout(layout, ["pane-1", "pane-2", "pane-4", "pane-5", "pane-6"]);
		expect(next.focusedPaneId).toBe("pane-4");
	});

	it("falls back to the previous pane when no later pane survives", () => {
		const layout = focusPane(createClientPaneLayout(panes(6)), "pane-6");
		const next = reconcileClientPaneLayout(layout, ["pane-1", "pane-2", "pane-3", "pane-4", "pane-5"]);
		expect(next.focusedPaneId).toBe("pane-5");
	});

	it("skips other removed panes to reach the nearest survivor", () => {
		const layout = focusPane(createClientPaneLayout(panes(6)), "pane-3");
		const next = reconcileClientPaneLayout(layout, ["pane-1", "pane-2", "pane-5", "pane-6"]);
		expect(next.focusedPaneId).toBe("pane-5");
	});

	it("selects the first pane when focus was null but panes now exist", () => {
		const empty = createClientPaneLayout([]);
		const next = reconcileClientPaneLayout(empty, panes(2));
		expect(next.focusedPaneId).toBe("pane-1");
	});

	it("clears focus for an empty pane set", () => {
		const layout = createClientPaneLayout(panes(2));
		const next = reconcileClientPaneLayout(layout, []);
		expect(next.focusedPaneId).toBeNull();
		expect(next.paneIds).toEqual([]);
	});
});

describe("reconcileClientPaneLayout — zoom", () => {
	it("keeps a still-present zoom target", () => {
		const layout = zoomPane(createClientPaneLayout(panes(3)), "pane-2");
		const next = reconcileClientPaneLayout(layout, ["pane-1", "pane-2", "pane-3", "pane-4"]);
		expect(next.zoomedPaneId).toBe("pane-2");
	});

	it("clears zoom when the zoomed pane is removed but keeps a surviving focus", () => {
		const focused = focusPane(createClientPaneLayout(panes(3)), "pane-1");
		const zoomed = zoomPane(focused, "pane-3");
		const next = reconcileClientPaneLayout(zoomed, ["pane-1", "pane-2"]);
		expect(next.zoomedPaneId).toBeNull();
		expect(next.focusedPaneId).toBe("pane-1");
	});

	it("clears zoom for an empty pane set", () => {
		const zoomed = zoomPane(createClientPaneLayout(panes(2)), "pane-1");
		const next = reconcileClientPaneLayout(zoomed, []);
		expect(next.zoomedPaneId).toBeNull();
	});
});

describe("reconcileClientPaneLayout — reorder & no-op", () => {
	it("preserves focus and zoom across a pure reorder", () => {
		const layout = zoomPane(focusPane(createClientPaneLayout(panes(3)), "pane-2"), "pane-2");
		const next = reconcileClientPaneLayout(layout, ["pane-3", "pane-1", "pane-2"]);
		expect(next.paneIds).toEqual(["pane-3", "pane-1", "pane-2"]);
		expect(next.focusedPaneId).toBe("pane-2");
		expect(next.zoomedPaneId).toBe("pane-2");
	});

	it("returns the same reference when nothing changed", () => {
		const layout = focusPane(createClientPaneLayout(panes(3)), "pane-2");
		expect(reconcileClientPaneLayout(layout, panes(3))).toBe(layout);
	});

	it("normalizes duplicates from the shared set", () => {
		const layout = createClientPaneLayout(panes(2));
		const next = reconcileClientPaneLayout(layout, ["pane-1", "pane-1", "pane-2", "pane-2"]);
		expect(next.paneIds).toEqual(["pane-1", "pane-2"]);
	});
});

describe("local mutations never alter the shared pane list or PTY dimensions", () => {
	it("keeps the shared pane array reference identical across focus/zoom mutations", () => {
		const base = createClientPaneLayout(panes(4));
		const focused = focusPane(base, "pane-3");
		const zoomed = zoomPane(focused, "pane-3");
		const toggled = toggleZoom(zoomed, "pane-3");
		const unzoomed = unzoomPane(zoomed);

		for (const result of [focused, zoomed, toggled, unzoomed]) {
			expect(result.paneIds).toBe(base.paneIds);
			expect(result.paneIds).toEqual(["pane-1", "pane-2", "pane-3", "pane-4"]);
		}
	});

	it("does not mutate the caller's shared array or the input layout", () => {
		const shared = panes(3);
		const sharedSnapshot = [...shared];
		const layout = createClientPaneLayout(shared);
		const layoutSnapshot: ClientPaneLayout = {
			paneIds: [...layout.paneIds],
			focusedPaneId: layout.focusedPaneId,
			zoomedPaneId: layout.zoomedPaneId,
		};

		focusPane(layout, "pane-2");
		zoomPane(layout, "pane-3");
		reconcileClientPaneLayout(layout, ["pane-1"]);

		expect(shared).toEqual(sharedSnapshot);
		expect(layout).toEqual(layoutSnapshot);
	});

	it("carries no PTY dimension fields on any produced state", () => {
		const layout = zoomPane(focusPane(createClientPaneLayout(panes(2)), "pane-2"), "pane-2");
		expect(Object.keys(layout).sort()).toEqual([...STATE_KEYS].sort());
	});

	it("is a pure, import-free source with no runtime or PTY dependencies", () => {
		const source = readFileSync(MODULE_SOURCE, "utf8");
		expect(source).not.toMatch(/^\s*import\s/m);
		expect(source).not.toMatch(/\brequire\s*\(/);
		// Strip comments so the dependency scan sees code, not the prose that
		// documents the very tokens it forbids (e.g. "no PTY dimension").
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		expect(code).not.toMatch(/\b(?:React|tmux|Bun\.Terminal|WebSocket|api\.request|node:)\b/i);
		expect(code).not.toMatch(/\b(?:pty|cols|rows|resize|dimensions?|viewport)\b/i);
	});
});

describe("focus & zoom mutations", () => {
	it("no-ops focusing an absent pane", () => {
		const layout = createClientPaneLayout(panes(2));
		expect(focusPane(layout, "pane-9")).toBe(layout);
	});

	it("no-ops focusing the already-focused pane", () => {
		const layout = createClientPaneLayout(panes(2));
		expect(focusPane(layout, "pane-1")).toBe(layout);
	});

	it("zooms the focused pane by default and independent of focus", () => {
		const layout = focusPane(createClientPaneLayout(panes(3)), "pane-2");
		const zoomed = zoomPane(layout);
		expect(zoomed.zoomedPaneId).toBe("pane-2");
		expect(zoomed.focusedPaneId).toBe("pane-2");

		const otherZoom = zoomPane(layout, "pane-3");
		expect(otherZoom.zoomedPaneId).toBe("pane-3");
		expect(otherZoom.focusedPaneId).toBe("pane-2");
	});

	it("no-ops zooming an absent pane and never zooms without a target", () => {
		const layout = createClientPaneLayout(panes(2));
		expect(zoomPane(layout, "pane-9")).toBe(layout);
		const empty = createClientPaneLayout([]);
		expect(zoomPane(empty)).toBe(empty);
	});

	it("toggles zoom on and off", () => {
		const layout = focusPane(createClientPaneLayout(panes(2)), "pane-1");
		const on = toggleZoom(layout);
		expect(isPaneZoomed(on)).toBe(true);
		const off = toggleZoom(on);
		expect(isPaneZoomed(off)).toBe(false);
		expect(off.focusedPaneId).toBe("pane-1");
	});

	it("no-ops unzoom when nothing is zoomed", () => {
		const layout = createClientPaneLayout(panes(2));
		expect(unzoomPane(layout)).toBe(layout);
	});
});

describe("two clients reconcile independently over the same shared pane set", () => {
	it("evolves each client's focus and zoom from its own prior state", () => {
		const shared = panes(4);
		const clientA = zoomPane(focusPane(createClientPaneLayout(shared), "pane-2"), "pane-2");
		const clientB = focusPane(createClientPaneLayout(shared), "pane-4");

		const nextShared = ["pane-1", "pane-3", "pane-4"]; // pane-2 removed + reordered
		const nextA = reconcileClientPaneLayout(clientA, nextShared);
		const nextB = reconcileClientPaneLayout(clientB, nextShared);

		expect(nextA.paneIds).toEqual(nextShared);
		expect(nextB.paneIds).toEqual(nextShared);

		// A lost its focused+zoomed pane-2 → focus falls back, zoom clears.
		expect(nextA.focusedPaneId).toBe("pane-3");
		expect(nextA.zoomedPaneId).toBeNull();

		// B kept its independent focus, untouched by A's reconciliation.
		expect(nextB.focusedPaneId).toBe("pane-4");
		expect(nextB.zoomedPaneId).toBeNull();
	});

	it("isolates observers: mutating one client does not touch another", () => {
		const shared = panes(3);
		const clientA = createClientPaneLayout(shared);
		const clientB = createClientPaneLayout(shared);

		const movedA = zoomPane(focusPane(clientA, "pane-3"), "pane-3");

		expect(clientB.focusedPaneId).toBe("pane-1");
		expect(clientB.zoomedPaneId).toBeNull();
		expect(movedA.focusedPaneId).toBe("pane-3");
		expect(clientA.focusedPaneId).toBe("pane-1"); // original A is immutable
	});
});

describe("validateClientPaneLayout", () => {
	it("accepts every state produced by reconciliation across a churn sequence", () => {
		let layout = createClientPaneLayout(panes(6));
		const churn: string[][] = [
			["pane-1", "pane-2", "pane-3", "pane-4", "pane-5", "pane-6"],
			["pane-2", "pane-4", "pane-6"],
			[],
			["pane-7", "pane-8"],
			["pane-8", "pane-7"],
		];
		for (const shared of churn) {
			layout = reconcileClientPaneLayout(layout, shared);
			layout = toggleZoom(layout);
			expect(validateClientPaneLayout(layout).valid).toBe(true);
		}
	});

	it("rejects a dangling focus, dangling zoom, duplicates, and focus on empty", () => {
		expect(validateClientPaneLayout({ paneIds: ["a"], focusedPaneId: "b", zoomedPaneId: null }).valid).toBe(false);
		expect(validateClientPaneLayout({ paneIds: ["a"], focusedPaneId: "a", zoomedPaneId: "z" }).valid).toBe(false);
		expect(validateClientPaneLayout({ paneIds: ["a", "a"], focusedPaneId: "a", zoomedPaneId: null }).valid).toBe(false);
		expect(validateClientPaneLayout({ paneIds: [], focusedPaneId: "a", zoomedPaneId: null }).valid).toBe(false);
		expect(validateClientPaneLayout("nope").valid).toBe(false);
	});
});
