import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretCliHandlers, secretHandlers } from "../rpc-handlers/secrets";
import { setPushMessage } from "../rpc-handlers/shared-pure";
import { spawn } from "../spawn";
import * as data from "../data";
import type { Task } from "../../shared/types";

vi.mock("../data", () => ({ getProject: vi.fn(), loadTasks: vi.fn() }));
vi.mock("../spawn", () => ({ spawn: vi.fn() }));
const task = { id: "task-0001", title: "Upload", status: "in-progress", worktreePath: "/worktree", lifecycleStartedAt: "2026-11-01T00:00:00Z" } as Task;
const params = { projectId: "p", taskId: task.id, env: "TOKEN", command: ["upload"] };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(data.getProject).mockResolvedValue({ id: "p" } as Awaited<ReturnType<typeof data.getProject>>);
	vi.mocked(data.loadTasks).mockResolvedValue([{ ...task }]);
	vi.mocked(spawn).mockReturnValue({ exited: Promise.resolve(0) } as ReturnType<typeof spawn>);
	setPushMessage(vi.fn());
});

async function pending() {
	const controller = new AbortController();
	const result = secretCliHandlers["secret.run"]!(params, { signal: controller.signal });
	await vi.waitFor(async () => expect(await secretHandlers.listSecretRequests()).toHaveLength(1));
	const request = (await secretHandlers.listSecretRequests())[0]!;
	return { result, request, controller };
}

describe("secret handlers", () => {
	it("resolves task context, hands off once and erases the submitted RPC value", async () => {
		const { result, request } = await pending();
		expect(request).toMatchObject({ taskId: task.id, cwd: task.worktreePath, env: "TOKEN", command: ["upload"] });
		const answer = { requestId: request.requestId, secret: "test-private-value" };
		expect(await secretHandlers.respondToSecretRequest(answer)).toBe(true);
		expect(answer).toEqual({ requestId: request.requestId });
		expect(await result).toEqual({ status: "finished", exitCode: 0 });
	});
	it.each(["hibernated", "missing", "completed"])("refuses a %s task before asking for a value", async (state) => {
		vi.mocked(data.loadTasks).mockResolvedValue([{ ...task, ...(state === "hibernated" ? { hibernated: true } : state === "missing" ? { worktreePath: undefined } : { status: "completed" }) } as Task]);
		await expect(secretCliHandlers["secret.run"]!(params)).rejects.toThrow("active task worktree");
		expect(await secretHandlers.listSecretRequests()).toEqual([]);
	});
	it("rechecks the task run after approval", async () => {
		const { result, request } = await pending();
		vi.mocked(data.loadTasks).mockResolvedValue([{ ...task, lifecycleStartedAt: "another-run" }]);
		await secretHandlers.respondToSecretRequest({ requestId: request.requestId, secret: "test-private-value" });
		expect(await result).toEqual({ status: "failed" });
		expect(spawn).not.toHaveBeenCalled();
	});
	it("drops late answers without echoing or retaining their values", async () => {
		const { result, request, controller } = await pending();
		controller.abort();
		await result;
		const answer = { requestId: request.requestId, secret: "test-private-value" };
		expect(await secretHandlers.respondToSecretRequest(answer)).toBe(false);
		expect(answer).not.toHaveProperty("secret");
		expect(spawn).not.toHaveBeenCalled();
	});
});
