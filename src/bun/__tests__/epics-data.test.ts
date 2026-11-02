import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/epics-data`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME,
	OPS_DIR: `${DEV3_HOME}/ops`,
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

const EPICS_FILE = `${DEV3_HOME}/epics.json`;

beforeEach(async () => {
	rmSync(DEV3_HOME, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
	const { _resetEpicsCache } = await import("../epics-data");
	_resetEpicsCache();
});

import { EpicValidationError, createEpic, findEpic, loadEpicsFile, updateEpic } from "../epics-data";
import { EPIC_REF_INVALID_PREFIX } from "../../shared/types";

describe("epics registry", () => {
	it("is the empty shape while epics.json is missing, and reading never creates it", async () => {
		expect(await loadEpicsFile()).toEqual({ version: 1, epics: [] });
		expect(existsSync(EPICS_FILE)).toBe(false);
	});

	it("creates an epic with a free-text name and persists it", async () => {
		const epic = await createEpic("  Оплата v2  ", "#3B82F6");
		expect(epic).toMatchObject({ name: "Оплата v2", color: "#3b82f6", archived: false });
		const onDisk = JSON.parse(readFileSync(EPICS_FILE, "utf8"));
		expect(onDisk.epics).toHaveLength(1);
		expect(onDisk.epics[0].id).toBe(epic.id);
	});

	it("picks a palette colour when none is given and refuses a bad one", async () => {
		expect((await createEpic("A")).color).toMatch(/^#[0-9a-f]{6}$/);
		await expect(createEpic("B", "blue")).rejects.toBeInstanceOf(EpicValidationError);
	});

	it("refuses an empty name and names that differ only by case, archived included", async () => {
		await expect(createEpic("   ")).rejects.toBeInstanceOf(EpicValidationError);
		const first = await createEpic("Payments v2");
		await expect(createEpic("PAYMENTS V2")).rejects.toThrow(/already exists/);
		await updateEpic(first.id, { archived: true });
		await expect(createEpic("payments v2")).rejects.toThrow(/archived/);
	});

	it("renames and recolours by id, refusing a rename onto another epic's name", async () => {
		const a = await createEpic("Alpha");
		await createEpic("Beta");
		expect(await updateEpic(a.id, { name: "Gamma", color: "#ef4444" })).toMatchObject({ id: a.id, name: "Gamma", color: "#ef4444" });
		await expect(updateEpic(a.id, { name: "beta" })).rejects.toBeInstanceOf(EpicValidationError);
		// Renaming to a different case of its own name is fine.
		expect((await updateEpic(a.id, { name: "GAMMA" })).name).toBe("GAMMA");
	});

	it("archives and unarchives without removing anything", async () => {
		const epic = await createEpic("Effort");
		expect((await updateEpic(epic.id, { archived: true })).archived).toBe(true);
		expect((await updateEpic(epic.id, { archived: false })).archived).toBe(false);
		expect((await loadEpicsFile()).epics).toHaveLength(1);
	});

	it("resolves a ref by name (any case), id or id prefix, and refuses unknown ones with the coded error", async () => {
		const epic = await createEpic("Payments v2");
		expect((await findEpic("payments V2")).id).toBe(epic.id);
		expect((await findEpic(epic.id)).id).toBe(epic.id);
		expect((await findEpic(epic.id.slice(0, 8))).id).toBe(epic.id);
		await expect(findEpic("Paymnts")).rejects.toThrow(EPIC_REF_INVALID_PREFIX);
	});
});
