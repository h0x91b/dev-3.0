import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-last-route`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { saveLastRoute, loadLastRoute } from "../data";

const LAST_ROUTE_FILE = `${TEST_HOME}/last-route.json`;

describe("last route persistence", () => {
	it("returns null when no route has been saved", async () => {
		expect(await loadLastRoute()).toBeNull();
	});

	it("persists a saved route and reads it back", async () => {
		const route = JSON.stringify({ screen: "task", projectId: "p1", taskId: "t1" });
		await saveLastRoute(route);
		expect(existsSync(LAST_ROUTE_FILE)).toBe(true);
		expect(await loadLastRoute()).toBe(route);
	});

	it("does NOT clear the route on read — survives repeated launches", async () => {
		// Regression: the old update-route helper cleared the file on read, so a
		// second restart (quit → reboot) lost the route. It must persist until
		// the next navigation overwrites it.
		const route = JSON.stringify({ screen: "project", projectId: "p1" });
		await saveLastRoute(route);

		expect(await loadLastRoute()).toBe(route);
		expect(await loadLastRoute()).toBe(route);
		expect(existsSync(LAST_ROUTE_FILE)).toBe(true);
	});

	it("overwrites the previous route on the next save", async () => {
		await saveLastRoute(JSON.stringify({ screen: "dashboard" }));
		const next = JSON.stringify({ screen: "settings" });
		await saveLastRoute(next);
		expect(await loadLastRoute()).toBe(next);
	});
});
