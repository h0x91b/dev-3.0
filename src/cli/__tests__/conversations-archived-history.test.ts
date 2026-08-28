/**
 * `dev3 conversations search` reads the store off disk instead of going through
 * the app, so it owns its own sidecar reader. It has to tolerate a directory
 * that does not exist yet (a store nobody has saved since the split) and a
 * half-written blob, because a search must never fail over cold data.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadArchivedHistory, resolveHomes } from "../commands/conversations";

const HOME = `${process.env.DEV3_TEST_ROOT}/cli-archived-history`;
const DIR = `${HOME}/data/slug/task-blobs`;

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(DIR, { recursive: true });
});

const entry = { at: "2026-01-01T00:00:00Z", changed: "title" as const, title: "Old name" };

describe("loadArchivedHistory", () => {
	it("returns each task's archived history keyed by task id", () => {
		writeFileSync(`${DIR}/a.json`, JSON.stringify({ taskId: "a", history: [entry] }));
		writeFileSync(`${DIR}/b.json`, JSON.stringify({ taskId: "b", history: [entry, entry] }));

		const got = loadArchivedHistory(HOME, "slug");

		expect(got.get("a")).toEqual([entry]);
		expect(got.get("b")).toHaveLength(2);
	});

	it("is empty when the store has no task-blobs directory", () => {
		rmSync(DIR, { recursive: true, force: true });
		expect(loadArchivedHistory(HOME, "slug").size).toBe(0);
	});

	it("skips a half-written blob and non-json files instead of failing", () => {
		writeFileSync(`${DIR}/broken.json`, '{"taskId":"broken","history":[');
		writeFileSync(`${DIR}/notes.txt`, JSON.stringify({ taskId: "txt", history: [entry] }));
		writeFileSync(`${DIR}/good.json`, JSON.stringify({ taskId: "good", history: [entry] }));

		const got = loadArchivedHistory(HOME, "slug");

		expect([...got.keys()]).toEqual(["good"]);
	});

	it("omits a blob that carries only diff stats", () => {
		writeFileSync(
			`${DIR}/stats.json`,
			JSON.stringify({ taskId: "stats", completedDiffFileStats: [{ path: "a.ts", insertions: 1, deletions: 0 }] }),
		);
		expect(loadArchivedHistory(HOME, "slug").size).toBe(0);
	});
});

/**
 * Which board `dev3 conversations` addresses. This read `$HOME` directly once, so
 * a redirected instance was invisible: the import dry-run loaded the real board's
 * tasks, found none of its own session ids, and offered conversations that
 * instance had already imported.
 */
describe("resolveHomes", () => {
	it("honours a redirected data root outside a worktree", () => {
		const previous = process.env.DEV3_HOME;
		process.env.DEV3_HOME = `${HOME}/scoped/.dev3.0`;
		try {
			expect(resolveHomes("/somewhere/else").dev3Home).toBe(`${HOME}/scoped/.dev3.0`);
		} finally {
			if (previous === undefined) delete process.env.DEV3_HOME;
			else process.env.DEV3_HOME = previous;
		}
	});

	it("reports the real user home, not the data root's parent", () => {
		const previous = process.env.DEV3_HOME;
		process.env.DEV3_HOME = "/var/tmp/some-scoped-root";
		try {
			// `~/.claude` is where the transcripts are, wherever the board lives.
			expect(resolveHomes("/somewhere/else").home).not.toBe("/var/tmp");
		} finally {
			if (previous === undefined) delete process.env.DEV3_HOME;
			else process.env.DEV3_HOME = previous;
		}
	});
});
