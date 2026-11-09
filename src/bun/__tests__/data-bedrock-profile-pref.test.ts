import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-bedrock-profile-pref`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { getRememberedBedrockProfile, rememberBedrockProfile, setLastPickedFolder } from "../data";

describe("remembered AWS profile pick", () => {
	it("is undefined for a project that never picked one", async () => {
		expect(await getRememberedBedrockProfile("p1")).toBeUndefined();
	});

	it("remembers the last explicit pick per project", async () => {
		await rememberBedrockProfile("p1", ["og"]);
		await rememberBedrockProfile("p2", ["sandbox"]);
		expect(await getRememberedBedrockProfile("p1")).toBe("og");
		expect(await getRememberedBedrockProfile("p2")).toBe("sandbox");
	});

	it("remembers None (null) as a choice distinct from never picked", async () => {
		await rememberBedrockProfile("p1", ["og"]);
		await rememberBedrockProfile("p1", [null]);
		expect(await getRememberedBedrockProfile("p1")).toBeNull();
	});

	it("ignores launches with no explicit pick and keeps the previous one", async () => {
		await rememberBedrockProfile("p1", ["og"]);
		await rememberBedrockProfile("p1", [undefined, undefined]);
		expect(await getRememberedBedrockProfile("p1")).toBe("og");
	});

	it("takes the last explicit pick of a multi-variant launch", async () => {
		await rememberBedrockProfile("p1", ["og", undefined, "kort"]);
		expect(await getRememberedBedrockProfile("p1")).toBe("kort");
	});

	it("keeps the other preferences in the same file", async () => {
		await setLastPickedFolder("/tmp/x");
		await rememberBedrockProfile("p1", ["og"]);
		const prefs = JSON.parse(readFileSync(`${TEST_HOME}/preferences.json`, "utf8"));
		expect(prefs.lastPickedFolder).toBe("/tmp/x");
		expect(prefs.bedrockProfileByProject).toEqual({ p1: "og" });
	});
});
