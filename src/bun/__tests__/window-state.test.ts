import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
	loadWindowStates,
	saveWindowStates,
	displayContaining,
	resolveRestoreFrame,
	type WindowState,
	type DisplayLike,
} from "../window-state";

const tmpDirs: string[] = [];
function tmpFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "dev3-winstate-"));
	tmpDirs.push(dir);
	return join(dir, "window-state.json");
}

afterEach(() => {
	while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const baseState: WindowState = {
	frame: { x: 100, y: 100, width: 1200, height: 800 },
	fullscreen: false,
	displayId: 1,
	displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
};

const secondState: WindowState = {
	frame: { x: 2100, y: 40, width: 900, height: 600 },
	fullscreen: true,
	displayId: 2,
	displayBounds: { x: 1920, y: 0, width: 2560, height: 1440 },
};

describe("loadWindowStates / saveWindowStates", () => {
	it("round-trips every window of a session, in order", () => {
		const path = tmpFile();
		saveWindowStates([baseState, secondState], path);
		expect(loadWindowStates(path)).toEqual([baseState, secondState]);
	});

	it("also writes the first window at the top level, so an older install still restores it", () => {
		const path = tmpFile();
		saveWindowStates([baseState, secondState], path);
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		expect(raw.frame).toEqual(baseState.frame);
		expect(raw.fullscreen).toBe(baseState.fullscreen);
		expect(raw.displayId).toBe(baseState.displayId);
	});

	it("reads a file written by the old single-window format", () => {
		const path = tmpFile();
		writeFileSync(path, JSON.stringify(baseState), "utf-8");
		expect(loadWindowStates(path)).toEqual([baseState]);
	});

	it("returns an empty session when the file does not exist", () => {
		expect(loadWindowStates(join(tmpdir(), "nope-does-not-exist.json"))).toEqual([]);
	});

	it("drops structurally invalid entries and keeps the good ones", () => {
		const path = tmpFile();
		const broken = { ...baseState, frame: { x: 0, y: 0, width: 0, height: 0 } };
		writeFileSync(path, JSON.stringify({ ...baseState, windows: [broken, secondState] }), "utf-8");
		expect(loadWindowStates(path)).toEqual([secondState]);
	});

	it("returns an empty session for a wholly invalid file", () => {
		const path = tmpFile();
		writeFileSync(path, "{not json", "utf-8");
		expect(loadWindowStates(path)).toEqual([]);
	});
});

describe("displayContaining", () => {
	const displays: DisplayLike[] = [
		{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
		{ id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
	];

	it("finds the display holding the window center", () => {
		expect(displayContaining({ x: 2000, y: 100, width: 800, height: 600 }, displays)?.id).toBe(2);
	});

	it("returns null when the center is off every display", () => {
		expect(displayContaining({ x: -5000, y: 0, width: 100, height: 100 }, displays)).toBeNull();
	});
});

describe("resolveRestoreFrame", () => {
	const displays: DisplayLike[] = [
		{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
		{ id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
	];

	it("restores the frame verbatim when it fits on the matched display", () => {
		const secondScreen: WindowState = {
			frame: { x: 2100, y: 200, width: 1000, height: 700 },
			fullscreen: true,
			displayId: 2,
			displayBounds: { x: 1920, y: 0, width: 2560, height: 1440 },
		};
		expect(resolveRestoreFrame(secondScreen, displays)).toEqual({
			frame: { x: 2100, y: 200, width: 1000, height: 700 },
			fullscreen: true,
		});
	});

	it("falls back to bounds match when the display id churned", () => {
		const churned: WindowState = { ...baseState, displayId: 999 };
		expect(resolveRestoreFrame(churned, displays)?.frame).toEqual(baseState.frame);
	});

	it("returns null when the saved display is gone", () => {
		const gone: WindowState = {
			...baseState,
			displayId: 7,
			displayBounds: { x: 5000, y: 0, width: 1280, height: 720 },
		};
		expect(resolveRestoreFrame(gone, displays)).toBeNull();
	});

	it("clamps an oversized / off-screen frame back inside the display", () => {
		const off: WindowState = {
			...baseState,
			frame: { x: 1800, y: 1000, width: 3000, height: 2000 },
		};
		const res = resolveRestoreFrame(off, displays);
		expect(res).not.toBeNull();
		const f = res!.frame;
		expect(f.width).toBe(1920);
		expect(f.height).toBe(1080);
		expect(f.x).toBe(0);
		expect(f.y).toBe(0);
	});
});
