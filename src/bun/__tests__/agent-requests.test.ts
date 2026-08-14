import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

const push = vi.fn();
vi.mock("../rpc-handlers/shared-pure", () => ({
	getPushMessage: () => push,
}));

import {
	createAgentRequest,
	resolveAgentRequest,
	_resetAgentRequestsForTests,
} from "../agent-requests";

beforeEach(() => {
	_resetAgentRequestsForTests();
	push.mockClear();
});

describe("createAgentRequest", () => {
	it("creates a new pending request with a unique id", () => {
		const a = createAgentRequest("complete", "task-1", "proj-1");
		const b = createAgentRequest("complete", "task-2", "proj-1");

		expect(a.isNew).toBe(true);
		expect(b.isNew).toBe(true);
		expect(a.requestId).not.toBe(b.requestId);
	});

	it("joins the existing request for the same task and kind instead of duplicating", () => {
		const first = createAgentRequest("complete", "task-1", "proj-1");
		const second = createAgentRequest("complete", "task-1", "proj-1");

		expect(second.isNew).toBe(false);
		expect(second.requestId).toBe(first.requestId);
		expect(second.decision).toBe(first.decision);
	});

	it("keeps different kinds for the same task independent", () => {
		const complete = createAgentRequest("complete", "task-1", "proj-1");
		const launch = createAgentRequest("launch", "task-1", "proj-1");

		expect(launch.isNew).toBe(true);
		expect(launch.requestId).not.toBe(complete.requestId);
	});

	it("creates a fresh request after the previous one was resolved", () => {
		const first = createAgentRequest("complete", "task-1", "proj-1");
		resolveAgentRequest(first.requestId, { approved: false });

		const second = createAgentRequest("complete", "task-1", "proj-1");
		expect(second.isNew).toBe(true);
		expect(second.requestId).not.toBe(first.requestId);
	});
});

describe("resolveAgentRequest", () => {
	it("resolves the decision promise with approval", async () => {
		const { requestId, decision } = createAgentRequest("complete", "task-1", "proj-1");

		expect(resolveAgentRequest(requestId, { approved: true })).toBe(true);
		await expect(decision).resolves.toEqual({ approved: true });
	});

	it("resolves the decision promise on decline", async () => {
		const { requestId, decision } = createAgentRequest("complete", "task-1", "proj-1");

		expect(resolveAgentRequest(requestId, { approved: false })).toBe(true);
		await expect(decision).resolves.toEqual({ approved: false });
	});

	it("carries the picked launch choice back to the waiter", async () => {
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1");
		const launch = { agentId: "builtin-claude", configId: "claude-auto", accountId: null };

		resolveAgentRequest(requestId, { approved: true, launch });
		await expect(decision).resolves.toEqual({ approved: true, launch });
	});

	it("returns false for an unknown requestId", () => {
		expect(resolveAgentRequest("nope", { approved: true })).toBe(false);
	});

	it("returns false when resolving the same request twice", () => {
		const { requestId } = createAgentRequest("complete", "task-1", "proj-1");
		expect(resolveAgentRequest(requestId, { approved: true })).toBe(true);
		expect(resolveAgentRequest(requestId, { approved: true })).toBe(false);
	});

	it("broadcasts agentRequestResolved so other clients close their copy of the dialog", () => {
		const { requestId } = createAgentRequest("launch", "task-1", "proj-1");

		resolveAgentRequest(requestId, { approved: true, launch: { agentId: null, configId: null } });

		expect(push).toHaveBeenCalledWith("agentRequestResolved", {
			requestId,
			kind: "launch",
			taskId: "task-1",
			projectId: "proj-1",
		});
	});

	it("does not broadcast for an unknown or already-resolved request", () => {
		const { requestId } = createAgentRequest("complete", "task-1", "proj-1");
		resolveAgentRequest(requestId, { approved: false });
		push.mockClear();

		resolveAgentRequest(requestId, { approved: false });
		resolveAgentRequest("nope", { approved: false });

		expect(push).not.toHaveBeenCalled();
	});

	it("resolves every joined waiter with the same decision", async () => {
		const first = createAgentRequest("complete", "task-1", "proj-1");
		const second = createAgentRequest("complete", "task-1", "proj-1");

		resolveAgentRequest(first.requestId, { approved: true });
		await expect(first.decision).resolves.toEqual({ approved: true });
		await expect(second.decision).resolves.toEqual({ approved: true });
	});
});
