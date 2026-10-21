import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import type { Project, SharedArtifact, Task } from "../../shared/types";
import { LIVE_READ_ONLY_PREFIX, LIVE_REV_CONFLICT_PREFIX } from "../../shared/live-artifact";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/live-artifact-handlers`);
const state = vi.hoisted(() => ({ task: null as unknown as Task, saved: 0 }));

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME, OPS_DIR: `${TEST_HOME}/ops` }));
vi.mock("../data", () => ({
	updateTaskWith: vi.fn(async (_project: unknown, _id: string, mutator: (task: Task) => { updates: Partial<Task>; result: unknown }) => {
		const { updates, result } = mutator(state.task);
		state.task = { ...state.task, ...updates };
		return { task: state.task, result };
	}),
}));
vi.mock("../shared-artifacts", () => ({
	SharedArtifactError: class extends Error {},
	saveSharedArtifact: vi.fn((_projectPath: string, htmlPath: string, _assets: string[], title?: string) => page(`saved-${++state.saved}`, title ?? htmlPath)),
}));

import { createLiveHandlers } from "../live-artifact-handlers";

function page(id: string, title: string): SharedArtifact {
	return { id, kind: "html", title, name: "index.html", storedPath: `/x/${id}/index.html`, originalPath: "/src/index.html", bytes: 1, createdAt: 1, assets: [], isUnread: true };
}

const project = { id: "p1", path: "/tmp/live-proj" } as Project;
const push = vi.fn();
const handlers = createLiveHandlers({ resolveTask: async () => ({ project, task: state.task }), push: () => push });
const call = (method: string, params: Record<string, unknown> = {}) => handlers[method]({ taskId: state.task.id, ...params });

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

let seq = 0;
beforeEach(() => {
	push.mockClear();
	state.task = { id: `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`, status: "in-progress" } as Task;
});

describe("live.publish / live.adopt", () => {
	it("replaces the page in place and bumps pageRev instead of adding versions", async () => {
		await call("live.publish", { htmlPath: "/src/a.html", title: "Plan" });
		const second = (await call("live.publish", { htmlPath: "/src/a.html" })) as { liveArtifact: { pageRev: number; page: SharedArtifact } };
		expect(second.liveArtifact.pageRev).toBe(2);
		expect(second.liveArtifact.page.title).toBe("Plan");
		expect(second.liveArtifact.page.isUnread).toBe(false);
		expect(state.task.sharedArtifacts).toBeUndefined();
		expect(push).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "p1" }));
	});

	it("adopts a chosen version of an existing artifact without touching it", async () => {
		const original: SharedArtifact = {
			...page("art-123456", "Report v2"),
			version: 2,
			previousVersions: [{ ...page("art-v1", "Report v1"), version: 1 }] as SharedArtifact["previousVersions"],
		};
		state.task = { ...state.task, sharedArtifacts: [original] };
		const result = (await call("live.adopt", { artifact: "art-12", version: 1 })) as { liveArtifact: { page: SharedArtifact } };
		expect(result.liveArtifact.page.storedPath).toBe("/x/art-v1/index.html");
		expect(result.liveArtifact.page.previousVersions).toBeUndefined();
		expect(state.task.sharedArtifacts?.[0]).toBe(original);
	});
});

describe("live documents", () => {
	it("writes as the agent and maps a stale write to the conflict prefix", async () => {
		await call("live.set", { collection: "cards", id: "c1", data: { title: "x" } });
		await call("live.patch", { collection: "cards", id: "c1", patch: { answer: "approve" }, ifRev: 1 });
		expect(await call("live.get", { collection: "cards", id: "c1" })).toMatchObject({ rev: 2, data: { title: "x", answer: "approve" } });
		await expect(call("live.set", { collection: "cards", id: "c1", data: 1, ifRev: 1 })).rejects.toThrow(LIVE_REV_CONFLICT_PREFIX);
		expect(await call("live.events")).toEqual([]);
	});

	it("keeps a finished task's live artifact readable but read-only", async () => {
		await call("live.set", { collection: "cards", id: "c1", data: 1 });
		state.task = { ...state.task, status: "completed" };
		await expect(call("live.set", { collection: "cards", id: "c1", data: 2 })).rejects.toThrow(LIVE_READ_ONLY_PREFIX);
		await expect(call("live.publish", { htmlPath: "/src/a.html" })).rejects.toThrow(LIVE_READ_ONLY_PREFIX);
		expect(await call("live.status")).toMatchObject({ readOnly: true, collections: { cards: 1 } });
	});

	it("clear removes the page but keeps data unless asked", async () => {
		await call("live.publish", { htmlPath: "/src/a.html" });
		await call("live.set", { collection: "cards", id: "c1", data: 1 });
		await call("live.clear");
		expect(state.task.liveArtifact).toBeUndefined();
		expect(await call("live.status")).toMatchObject({ collections: { cards: 1 } });
		await call("live.clear", { data: true });
		expect(await call("live.status")).toMatchObject({ collections: {} });
	});
});
