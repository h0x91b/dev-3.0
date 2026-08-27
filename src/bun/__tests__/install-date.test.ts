import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = "";

vi.mock("../paths", () => ({ get DEV3_HOME() { return home; } }));

/** Overrides statSync's answer for one test; null = let the real filesystem answer. */
let birthtimeOverride: number | null = null;
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		statSync: (...args: Parameters<typeof real.statSync>) =>
			birthtimeOverride === null
				? real.statSync(...args)
				: ({ birthtimeMs: birthtimeOverride } as ReturnType<typeof real.statSync>),
	};
});

async function loadModule() {
	vi.resetModules();
	return import("../install-date");
}

beforeEach(() => {
	birthtimeOverride = null;
	home = mkdtempSync(join(tmpdir(), "dev3-install-date-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, "install-date.json");

describe("resolveInstallDate", () => {
	// The point of reading the directory's birth time: an install from February
	// must not be reported as brand new the day this code first runs.
	it("seeds from the data directory's birth time, not from now", async () => {
		const { resolveInstallDate } = await loadModule();
		const birth = Math.floor(statSync(home).birthtimeMs);
		const now = birth + 90 * 86_400_000;

		const resolved = await resolveInstallDate(now);
		expect(resolved).toBe(birth);
		expect(resolved).not.toBe(now);
	});

	it("writes the answer down so later calls never re-derive it", async () => {
		const { resolveInstallDate } = await loadModule();
		const first = await resolveInstallDate(Date.now());
		expect(existsSync(file())).toBe(true);
		expect(JSON.parse(readFileSync(file(), "utf-8")).installedAt).toBe(first);
	});

	it("prefers the recorded value over the directory, which keeps moving", async () => {
		writeFileSync(file(), JSON.stringify({ installedAt: 1_700_000_000_000 }));
		const { resolveInstallDate } = await loadModule();
		expect(await resolveInstallDate(Date.now())).toBe(1_700_000_000_000);
	});

	// Several Linux filesystems report 0 or fall back to mtime here.
	it("falls back to now when the birth time is unusable", async () => {
		birthtimeOverride = 0;
		const { resolveInstallDate } = await loadModule();
		const now = 1_800_000_000_000;
		expect(await resolveInstallDate(now)).toBe(now);
	});

	// A clock skew or a copied directory can date the tree before dev3 existed.
	it("refuses a birth time from before dev3 existed", async () => {
		birthtimeOverride = Date.UTC(2019, 0, 1);
		const { resolveInstallDate } = await loadModule();
		const now = 1_800_000_000_000;
		expect(await resolveInstallDate(now)).toBe(now);
	});

	it("refuses a birth time in the future rather than reporting a negative age", async () => {
		birthtimeOverride = Date.UTC(2030, 0, 1);
		const { resolveInstallDate } = await loadModule();
		const now = 1_800_000_000_000;
		expect(await resolveInstallDate(now)).toBe(now);
	});

	it("ignores a corrupt record and re-seeds", async () => {
		writeFileSync(file(), "{ not json");
		const { resolveInstallDate } = await loadModule();
		expect(await resolveInstallDate(Date.now())).toBe(Math.floor(statSync(home).birthtimeMs));
	});

	it("ignores a record whose value is not a number", async () => {
		writeFileSync(file(), JSON.stringify({ installedAt: "yesterday" }));
		const { resolveInstallDate } = await loadModule();
		expect(await resolveInstallDate(Date.now())).toBe(Math.floor(statSync(home).birthtimeMs));
	});
});
