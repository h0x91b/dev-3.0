import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/state-backup`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import {
	countArrayEntries,
	countCatalogEntries,
	countSpaces,
	PROTECTED_STATE_FILES,
	protectedStateFile,
	settingsAdvance,
	snapshotProtectedState,
	snapshotStateFile,
	STATE_BACKUP_RETENTION_HOURS,
} from "../state-backup";

const HOUR_A = new Date("2026-08-31T10:00:00.000Z");
const HOUR_B = new Date("2026-08-31T11:00:00.000Z");
const SLOT_A = "2026-08-31T10Z.json";
const SLOT_B = "2026-08-31T11Z.json";

function write(basename: string, value: unknown): void {
	writeFileSync(`${TEST_HOME}/${basename}`, JSON.stringify(value, null, 2));
}

function listSlots(stem: string): string[] {
	const dir = `${TEST_HOME}/${stem}-backups`;
	return existsSync(dir)
		? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}Z\.json$/.test(f)).sort()
		: [];
}

function readGood(stem: string): unknown {
	return JSON.parse(readFileSync(`${TEST_HOME}/${stem}-last-known-good.json`, "utf-8"));
}

function projects(count: number): unknown[] {
	return Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}`, path: `/tmp/p${i}` }));
}

function agents(count: number): unknown[] {
	return Array.from({ length: count }, (_, i) => ({ id: `a${i}`, name: `A${i}`, baseCommand: "claude" }));
}

function spaces(count: number): unknown {
	const ids = Array.from({ length: count }, (_, i) => `sp_${i}`);
	return { version: 1, spaces: ids.map((id) => ({ id, name: id, projectIds: ["p0"] })), order: ids };
}

function catalog(providers: number, models: number): unknown {
	return {
		providers: Array.from({ length: providers }, (_, i) => ({ id: `pr${i}`, kind: "openrouter" })),
		models: Array.from({ length: models }, (_, i) => ({ name: `m${i}`, providerId: "pr0" })),
	};
}

function settings(extra: Record<string, unknown>): unknown {
	return { defaultAgentId: "builtin-claude", defaultConfigId: "x", taskSortOrder: "oldest-first", updateChannel: "canary", ...extra };
}

/** The whole registry, with a realistic payload and a stem, for the table-driven cases. */
const FIXTURES = [
	{ id: "projects", basename: "projects.json", stem: "projects", payload: () => projects(3) },
	{ id: "virtual-projects", basename: "virtual-projects.json", stem: "virtual-projects", payload: () => projects(2) },
	{ id: "spaces", basename: "spaces.json", stem: "spaces", payload: () => spaces(4) },
	{ id: "agents", basename: "agents.json", stem: "agents", payload: () => agents(5) },
	{ id: "model-catalog", basename: "model-catalog.json", stem: "model-catalog", payload: () => catalog(2, 3) },
	{ id: "settings", basename: "settings.json", stem: "settings", payload: () => settings({ theme: "dark", focusMode: true }) },
] as const;

describe("the protected-state registry", () => {
	it("covers exactly the files the fixtures describe", () => {
		expect(PROTECTED_STATE_FILES.map((e) => e.id).sort()).toEqual(FIXTURES.map((f) => f.id).sort());
	});

	it("derives sibling paths inside the data root, moving nothing that exists", () => {
		for (const fixture of FIXTURES) {
			const entry = protectedStateFile(fixture.id);
			expect(entry.file).toBe(`${TEST_HOME}/${fixture.basename}`);
			expect(entry.backupDir).toBe(`${TEST_HOME}/${fixture.stem}-backups`);
			expect(entry.lastKnownGoodFile).toBe(`${TEST_HOME}/${fixture.stem}-last-known-good.json`);
			expect(entry.retentionHours).toBe(STATE_BACKUP_RETENTION_HOURS);
		}
	});

	it("keeps the paths projects.json already shipped with", () => {
		// An older app version reads these exact names — see AGENTS.md on-disk rules.
		const entry = protectedStateFile("projects");
		expect(entry.backupDir).toBe(`${TEST_HOME}/projects-backups`);
		expect(entry.lastKnownGoodFile).toBe(`${TEST_HOME}/projects-last-known-good.json`);
	});
});

describe("hourly snapshots, per protected file", () => {
	for (const fixture of FIXTURES) {
		it(`snapshots ${fixture.basename} on a timer tick with no save at all`, async () => {
			const payload = fixture.payload();
			write(fixture.basename, payload);

			await snapshotProtectedState(HOUR_A);

			expect(listSlots(fixture.stem)).toEqual([SLOT_A]);
			const snapshot = JSON.parse(readFileSync(`${TEST_HOME}/${fixture.stem}-backups/${SLOT_A}`, "utf-8"));
			expect(snapshot).toEqual(payload);
			expect(readGood(fixture.stem)).toEqual(payload);
		});

		it(`writes at most one ${fixture.basename} snapshot per hour`, async () => {
			write(fixture.basename, fixture.payload());

			await snapshotProtectedState(HOUR_A);
			await snapshotProtectedState(new Date("2026-08-31T10:59:59.000Z"));

			expect(listSlots(fixture.stem)).toEqual([SLOT_A]);
		});

		it(`snapshots nothing when ${fixture.basename} does not exist yet`, async () => {
			await snapshotProtectedState(HOUR_A);

			expect(listSlots(fixture.stem)).toEqual([]);
			expect(existsSync(`${TEST_HOME}/${fixture.stem}-last-known-good.json`)).toBe(false);
		});

		it(`never lets unreadable ${fixture.basename} bytes become the good copy`, async () => {
			const payload = fixture.payload();
			write(fixture.basename, payload);
			await snapshotProtectedState(HOUR_A);

			writeFileSync(`${TEST_HOME}/${fixture.basename}`, "{ truncated");
			await snapshotProtectedState(HOUR_B);

			// The hourly slot records the wreck faithfully; the good copy does not move.
			expect(readFileSync(`${TEST_HOME}/${fixture.stem}-backups/${SLOT_B}`, "utf-8")).toBe("{ truncated");
			expect(readGood(fixture.stem)).toEqual(payload);
		});
	}

	it("gives one file's failure no power over the others", async () => {
		for (const fixture of FIXTURES) write(fixture.basename, fixture.payload());
		// A plain file where the backup directory has to go: mkdir fails with ENOTDIR.
		writeFileSync(`${TEST_HOME}/spaces-backups`, "not a directory");

		await snapshotProtectedState(HOUR_A);

		expect(listSlots("projects")).toEqual([SLOT_A]);
		expect(listSlots("settings")).toEqual([SLOT_A]);
		expect(listSlots("model-catalog")).toEqual([SLOT_A]);
	});
});

describe("what each counter is willing to count", () => {
	// `null` means "these bytes are not this file" — the collapse rule turns that
	// into a refusal, so a counter that guesses is a counter that lets a wreck
	// through. Asserted directly: through the registry a throwing counter looks
	// exactly like a refusing one, and only one of the two is intended.

	it("counts a plain JSON array, and nothing else", () => {
		expect(countArrayEntries(JSON.stringify(projects(4)))).toBe(4);
		expect(countArrayEntries("{}")).toBe(null);
		expect(countArrayEntries("{ truncated")).toBe(null);
	});

	it("counts spaces only in a file this app could read back", () => {
		expect(countSpaces(JSON.stringify(spaces(4)))).toBe(4);
		expect(countSpaces(JSON.stringify({ ...(spaces(4) as object), version: 2 }))).toBe(null);
		expect(countSpaces(JSON.stringify({ ...(spaces(4) as object), order: null }))).toBe(null);
		expect(countSpaces(JSON.stringify({ version: 1, order: [] }))).toBe(null);
		expect(countSpaces(JSON.stringify(projects(4)))).toBe(null);
	});

	it("counts both halves of the catalog, and refuses a file missing either", () => {
		expect(countCatalogEntries(JSON.stringify(catalog(2, 3)))).toBe(5);
		expect(countCatalogEntries(JSON.stringify({ ...(catalog(2, 3) as object), providers: null }))).toBe(null);
		expect(countCatalogEntries(JSON.stringify({ ...(catalog(2, 3) as object), models: undefined }))).toBe(null);
		expect(countCatalogEntries(JSON.stringify(projects(4)))).toBe(null);
	});
});

describe("the collapse rule, per file, in both directions", () => {
	async function twoHours(basename: string, first: unknown, second: unknown): Promise<void> {
		write(basename, first);
		await snapshotProtectedState(HOUR_A);
		write(basename, second);
		await snapshotProtectedState(HOUR_B);
	}

	it("projects.json: refuses a wiped list, accepts a deleted project or two", async () => {
		await twoHours("projects.json", projects(29), projects(1));
		expect(readGood("projects")).toHaveLength(29);

		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(TEST_HOME, { recursive: true });
		await twoHours("projects.json", projects(10), projects(8));
		expect(readGood("projects")).toHaveLength(8);
	});

	it("virtual-projects.json: refuses a wiped list, accepts a removed board", async () => {
		await twoHours("virtual-projects.json", projects(6), projects(0));
		expect(readGood("virtual-projects")).toHaveLength(6);

		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(TEST_HOME, { recursive: true });
		await twoHours("virtual-projects.json", projects(6), projects(5));
		expect(readGood("virtual-projects")).toHaveLength(5);
	});

	it("agents.json: refuses a wiped preset list, accepts presets removed by a release", async () => {
		await twoHours("agents.json", agents(20), agents(3));
		expect(readGood("agents")).toHaveLength(20);

		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(TEST_HOME, { recursive: true });
		await twoHours("agents.json", agents(20), agents(16));
		expect(readGood("agents")).toHaveLength(16);
	});

	it("spaces.json: refuses a wiped file, accepts an ordinary new space", async () => {
		// Deletion is soft — a space stays in the array — so a shrinking count is
		// already abnormal and a halved one is unambiguous.
		await twoHours("spaces.json", spaces(8), spaces(2));
		expect((readGood("spaces") as { spaces: unknown[] }).spaces).toHaveLength(8);

		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(TEST_HOME, { recursive: true });
		await twoHours("spaces.json", spaces(8), spaces(9));
		expect((readGood("spaces") as { spaces: unknown[] }).spaces).toHaveLength(9);
	});

	it("spaces.json: refuses a file whose shape it does not recognise", async () => {
		// GROWN, not shrunk, so the collapse rule would wave it through — only the
		// shape check can refuse a file this loader could not read back.
		write("spaces.json", spaces(3));
		await snapshotProtectedState(HOUR_A);

		write("spaces.json", { ...(spaces(9) as object), version: 2 });
		await snapshotProtectedState(HOUR_B);

		expect((readGood("spaces") as { spaces: unknown[] }).spaces).toHaveLength(3);
	});

	it("spaces.json: refuses a grown file that lost its display order", async () => {
		write("spaces.json", spaces(3));
		await snapshotProtectedState(HOUR_A);

		write("spaces.json", { ...(spaces(9) as object), order: null });
		await snapshotProtectedState(HOUR_B);

		expect((readGood("spaces") as { spaces: unknown[] }).spaces).toHaveLength(3);
	});

	it("model-catalog.json: refuses a wiped catalog, accepts a removed model", async () => {
		await twoHours("model-catalog.json", catalog(3, 9), catalog(1, 1));
		expect(readGood("model-catalog")).toEqual(catalog(3, 9));

		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(TEST_HOME, { recursive: true });
		await twoHours("model-catalog.json", catalog(3, 9), catalog(3, 7));
		expect(readGood("model-catalog")).toEqual(catalog(3, 7));
	});

	it("model-catalog.json: refuses a grown file that lost its provider list", async () => {
		write("model-catalog.json", catalog(2, 2));
		await snapshotProtectedState(HOUR_A);

		write("model-catalog.json", { ...(catalog(4, 8) as object), providers: null });
		await snapshotProtectedState(HOUR_B);

		expect(readGood("model-catalog")).toEqual(catalog(2, 2));
	});

	it("settings.json: refuses a file recreated from defaults, accepts a toggle going back to default", async () => {
		const rich = settings({ theme: "dark", focusMode: true, tipsDisabled: true, analyticsDistinctId: "abc", agentBinaryPaths: {}, externalApps: [] });
		// Exactly the 31 Aug shape: the file came back holding DEFAULT_SETTINGS only.
		await twoHours("settings.json", rich, settings({}));
		expect(readGood("settings")).toEqual(rich);

		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(TEST_HOME, { recursive: true });
		const trimmed = settings({ theme: "dark", focusMode: true, tipsDisabled: true, analyticsDistinctId: "abc", agentBinaryPaths: {} });
		await twoHours("settings.json", rich, trimmed);
		expect(readGood("settings")).toEqual(trimmed);
	});

	it("settings.json: a key the good copy never had is proof of a real edit, whatever the size", () => {
		// Counting keys alone would refuse this; the subset test is what saves it.
		const before = JSON.stringify(settings({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }));
		const after = JSON.stringify({ defaultAgentId: "builtin-claude", brandNewKey: true });
		expect(settingsAdvance(after, before)).toBe(true);
	});

	it("settings.json: refuses bytes that are not an object at all", () => {
		expect(settingsAdvance("[]", JSON.stringify(settings({})))).toBe(false);
		expect(settingsAdvance("{ truncated", JSON.stringify(settings({})))).toBe(false);
	});

	it("accepts the very first copy of every file, with nothing to compare against", async () => {
		for (const fixture of FIXTURES) write(fixture.basename, fixture.payload());
		await snapshotProtectedState(HOUR_A);
		for (const fixture of FIXTURES) expect(readGood(fixture.stem)).toEqual(fixture.payload());
	});
});

describe("retention", () => {
	it("evicts the oldest hour once the window is full, and never the good copy", async () => {
		write("spaces.json", spaces(4));
		await snapshotProtectedState(HOUR_A);

		const dir = `${TEST_HOME}/spaces-backups`;
		// Fill the window to exactly the cap with older hours, the earliest first.
		for (let i = 0; i < STATE_BACKUP_RETENTION_HOURS; i++) {
			const day = String((i % 28) + 1).padStart(2, "0");
			const hour = String(i % 24).padStart(2, "0");
			writeFileSync(`${dir}/2026-05-${day}T${hour}Z.json`, "{}");
		}
		const oldest = readdirSync(dir).sort()[0];
		expect(oldest).toBe("2026-05-01T00Z.json");

		write("spaces.json", spaces(5));
		await snapshotProtectedState(HOUR_B);

		const kept = listSlots("spaces");
		expect(kept).toHaveLength(STATE_BACKUP_RETENTION_HOURS);
		expect(kept).not.toContain(oldest);
		expect(kept).toContain(SLOT_B);
		expect((readGood("spaces") as { spaces: unknown[] }).spaces).toHaveLength(5);
	});

	it("leaves the good copy standing after the whole window has rotated out", async () => {
		write("projects.json", projects(12));
		await snapshotProtectedState(HOUR_A);
		expect(readGood("projects")).toHaveLength(12);

		// 80 further hours of a one-project wreck: every good hourly slot rotates away.
		write("projects.json", projects(1));
		for (let i = 0; i < 80; i++) {
			await snapshotStateFile(protectedStateFile("projects"), new Date(Date.UTC(2026, 8, 1 + Math.floor(i / 24), i % 24)));
		}

		expect(listSlots("projects").length).toBeLessThanOrEqual(STATE_BACKUP_RETENTION_HOURS);
		expect(listSlots("projects")).not.toContain(SLOT_A);
		expect(readGood("projects")).toHaveLength(12);
	});
});
