import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Task } from "../../shared/types";
import { buildFixtureTasks, fixtureProject, FIXTURE_PROJECT_SLUG } from "./task-store-fixture";

/**
 * The hourly tasks backup answers "is this hour covered" with stat(), not by reading
 * two whole files. Counts, not timings, so it holds in CI; cadence, content and the
 * hour the snapshot is filed under are asserted so the saving cannot cost a snapshot.
 */

const { testHome } = vi.hoisted(() => ({ testHome: `${process.env.DEV3_TEST_ROOT}/data-hourly-backup-io` }));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: testHome, OPS_DIR: `${testHome}/ops` }));
vi.mock("../cow-clone", () => ({ detectClonePaths: vi.fn(() => Promise.resolve([])) }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { readFile } from "node:fs/promises";
import { _resetDataCaches, loadTasks, updateTask } from "../data";

const DATA_DIR = `${testHome}/data/${FIXTURE_PROJECT_SLUG}`;
const TASKS_FILE = `${DATA_DIR}/tasks.json`;
const BACKUP_DIR = `${DATA_DIR}/tasks-backups`;
const TASK_COUNT = 60;
const BURST = 10;

const project = fixtureProject();
const fixture = buildFixtureTasks(TASK_COUNT);

const readPaths = () =>
	vi.mocked(readFile).mock.calls.map((call) => String(call[0]));
const backups = () => readdirSync(BACKUP_DIR).filter((name) => name.endsWith(".json")).sort();

beforeEach(() => {
	rmSync(testHome, { recursive: true, force: true });
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(TASKS_FILE, JSON.stringify(fixture, null, 2));
	writeFileSync(`${testHome}/projects.json`, JSON.stringify([project], null, 2));
	_resetDataCaches();
	vi.mocked(readFile).mockClear();
});

describe("hourly tasks backup I/O", () => {
	it("never reads an existing backup file to decide whether this hour is covered", async () => {
		await updateTask(project, fixture[0].id, { overview: "first" });
		expect(backups()).toHaveLength(1);
		vi.mocked(readFile).mockClear();

		for (let i = 1; i < BURST; i++) {
			await updateTask(project, fixture[i].id, { overview: `burst-${i}` });
		}

		// Zero reads of anything under tasks-backups/, and the store is read once per
		// mutation for the mutator load — never a second time to feed the backup.
		expect(readPaths().filter((path) => path.includes("tasks-backups"))).toEqual([]);
		expect(readPaths().filter((path) => path === TASKS_FILE)).toHaveLength(BURST - 1);
	});

	it("still snapshots once per hour, from the state before that hour's first save", async () => {
		const beforeAnySave = readFileSync(TASKS_FILE, "utf8");

		await updateTask(project, fixture[0].id, { overview: "first" });
		await updateTask(project, fixture[1].id, { overview: "second" });

		const files = backups();
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}Z\.json$/);
		expect(readFileSync(`${BACKUP_DIR}/${files[0]}`, "utf8")).toBe(beforeAnySave);
	});

	it("keeps a snapshot already taken this hour untouched", async () => {
		await updateTask(project, fixture[0].id, { overview: "first" });
		const [name] = backups();
		const snapshot = readFileSync(`${BACKUP_DIR}/${name}`, "utf8");

		await updateTask(project, fixture[2].id, { overview: "third" });

		expect(backups()).toEqual([name]);
		expect(readFileSync(`${BACKUP_DIR}/${name}`, "utf8")).toBe(snapshot);
	});

	it("files the snapshot under the hour that was current when the backup began", async () => {
		// The hour is now chosen before the snapshot's own read of the store, so a read
		// spanning the boundary lands in the hour the backup entered. The old code chose
		// it after that read and would have filed the same save an hour later.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-08-04T10:59:59.900Z"));
			let storeReads = 0;
			vi.mocked(readFile).mockImplementation(async (path, options) => {
				// Read 1 is the mutator load, read 2 is the snapshot's own read.
				if (String(path) === TASKS_FILE && ++storeReads === 2) {
					vi.setSystemTime(new Date("2026-08-04T11:00:00.100Z"));
				}
				const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
				return actual.readFile(path as never, options as never);
			});

			await updateTask(project, fixture[0].id, { overview: "boundary" });

			expect(storeReads).toBe(2);
			expect(backups()).toEqual(["2026-08-04T10Z.json"]);
		} finally {
			vi.useRealTimers();
			vi.mocked(readFile).mockRestore();
		}
	});

	it("loses no mutation and keeps the store's on-disk format", async () => {
		const target = fixture[4];
		for (let i = 1; i <= BURST; i++) {
			const current = (await loadTasks(project)).find((t) => t.id === target.id);
			await updateTask(project, target.id, { overview: `${current?.overview ?? ""}|${i}` });
		}

		const content = readFileSync(TASKS_FILE, "utf8");
		const persisted = JSON.parse(content) as Task[];
		expect(persisted).toHaveLength(TASK_COUNT);
		expect(persisted.find((t) => t.id === target.id)?.overview).toBe(`${target.overview}|1|2|3|4|5|6|7|8|9|10`);
		expect(content.startsWith("[\n  {\n")).toBe(true);
		expect(content).toBe(JSON.stringify(persisted, null, 2));
	});
});
