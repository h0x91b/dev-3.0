import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { liveSetDoc, LiveStoreError } from "../../shared/live-artifact";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/live-artifact-store`);

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME, OPS_DIR: `${TEST_HOME}/ops` }));

import { liveStoreDir, mutateLiveState, onLiveStoreChange, readLiveState, wipeLiveStore } from "../live-artifact-store";

const PROJECT = "/tmp/proj";
let seq = 0;
const newTaskId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const set = (taskId: string, data: unknown, extra: Record<string, unknown> = {}) =>
	mutateLiveState(PROJECT, taskId, (draft) => {
		const change = liveSetDoc(draft, { collection: "cards", id: "c1", by: "agent", now: 1, data, ...extra });
		return { result: change, changes: [change] };
	});

describe("live artifact store", () => {
	it("persists under worktrees/<slug>/live-artifacts/<taskId>/state.json", async () => {
		const taskId = newTaskId();
		await set(taskId, { title: "hello" });
		const file = `${liveStoreDir(PROJECT, taskId)}/state.json`;
		expect(file).toBe(`${TEST_HOME}/worktrees/tmp-proj/live-artifacts/${taskId}/state.json`);
		expect(JSON.parse(readFileSync(file, "utf8")).collections.cards.c1.data).toEqual({ title: "hello" });
	});

	it("leaves file and cache untouched when a mutation throws", async () => {
		const taskId = newTaskId();
		await set(taskId, { v: 1 });
		await expect(set(taskId, { v: 2 }, { ifRev: 99 })).rejects.toThrow(LiveStoreError);
		const state = await readLiveState(PROJECT, taskId);
		expect(state.collections.cards.c1.data).toEqual({ v: 1 });
	});

	it("serializes concurrent writes so no revision is lost", async () => {
		const taskId = newTaskId();
		await Promise.all(Array.from({ length: 10 }, (_, i) => set(taskId, { i })));
		expect((await readLiveState(PROJECT, taskId)).rev).toBe(10);
	});

	it("tells subscribers which documents changed", async () => {
		const taskId = newTaskId();
		const seen: string[] = [];
		const stop = onLiveStoreChange((event) => seen.push(`${event.taskId}:${event.changes.map((c) => `${c.collection}/${c.docId}@${c.rev}`).join(",")}`));
		await set(taskId, 1);
		stop();
		await set(taskId, 2);
		expect(seen).toEqual([`${taskId}:cards/c1@1`]);
	});

	it("refuses a task id that could escape its directory", () => {
		expect(() => liveStoreDir(PROJECT, "../../etc")).toThrow(LiveStoreError);
	});

	it("refuses to overwrite a state file it cannot read as a store", async () => {
		const taskId = newTaskId();
		mkdirSync(liveStoreDir(PROJECT, taskId), { recursive: true });
		const file = `${liveStoreDir(PROJECT, taskId)}/state.json`;
		writeFileSync(file, '{"something":"else"}');
		await expect(set(taskId, 1)).rejects.toThrow(/refusing/);
		expect(readFileSync(file, "utf8")).toBe('{"something":"else"}');
	});

	it("wipes only on request", async () => {
		const taskId = newTaskId();
		await set(taskId, 1);
		await wipeLiveStore(PROJECT, taskId);
		expect(existsSync(`${liveStoreDir(PROJECT, taskId)}/state.json`)).toBe(false);
		expect((await readLiveState(PROJECT, taskId)).rev).toBe(0);
	});
});
