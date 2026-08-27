import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

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
	listPendingAgentRequests,
	resolveAgentRequest,
	setAgentRequestLaunchChoice,
	_resetAgentRequestsForTests,
} from "../agent-requests";
import type { TaskDialogSubject } from "../../shared/types";

const SUBJECT: TaskDialogSubject = {
	seqLabel: "42",
	projectName: "Test Project",
	priority: "P3",
	labels: [],
	overview: null,
};

beforeEach(() => {
	_resetAgentRequestsForTests();
	push.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
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
		const launch = { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] };

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

		resolveAgentRequest(requestId, { approved: true, launch: { variants: [{ agentId: null, configId: null }] } });

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

describe("auto-approval", () => {
	it("approves itself once the deadline passes", async () => {
		vi.useFakeTimers();
		const { requestId, decision, autoApproveAt } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 5 * 60_000,
		});

		expect(autoApproveAt).toBe(Date.now() + 5 * 60_000);
		vi.advanceTimersByTime(5 * 60_000);

		await expect(decision).resolves.toEqual({ approved: true, launch: undefined });
		// Every other client's copy of the dialog has to close with it.
		expect(push).toHaveBeenCalledWith("agentRequestResolved", expect.objectContaining({ requestId }));
	});

	it("launches with the pick the dialog last reported", async () => {
		vi.useFakeTimers();
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});
		const launch = { variants: [{ agentId: "builtin-codex", configId: "codex-default", accountId: null }] };

		expect(setAgentRequestLaunchChoice(requestId, launch)).toBe(true);
		vi.advanceTimersByTime(60_000);

		await expect(decision).resolves.toEqual({ approved: true, launch });
	});

	it("never fires after the user answered", async () => {
		vi.useFakeTimers();
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});

		resolveAgentRequest(requestId, { approved: false });
		vi.advanceTimersByTime(10 * 60_000);

		await expect(decision).resolves.toEqual({ approved: false });
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("stays open forever when auto-approval is off", async () => {
		vi.useFakeTimers();
		const { decision, autoApproveAt } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 0,
		});
		let settled = false;
		void decision.then(() => { settled = true; });

		expect(autoApproveAt).toBeNull();
		vi.advanceTimersByTime(60 * 60_000);
		await Promise.resolve();

		expect(settled).toBe(false);
	});

	it("does not let a retrying agent postpone its own deadline", () => {
		vi.useFakeTimers();
		const first = createAgentRequest("launch", "task-1", "proj-1", { autoApproveAfterMs: 5 * 60_000 });
		vi.advanceTimersByTime(4 * 60_000);
		const retry = createAgentRequest("launch", "task-1", "proj-1", { autoApproveAfterMs: 5 * 60_000 });

		expect(retry.isNew).toBe(false);
		expect(retry.autoApproveAt).toBe(first.autoApproveAt);
	});

	it("ignores a choice reported for an unknown request", () => {
		expect(setAgentRequestLaunchChoice("nope", { variants: [{ agentId: null, configId: null }] })).toBe(false);
	});
});

// A dialog lives only as a promise inside a renderer, and the push that draws it
// fires once. Without this list, a renderer that reloads before answering leaves
// the request alive and unanswerable for the rest of the app session, because a
// retrying agent joins the same entry instead of triggering a second push.
describe("listPendingAgentRequests", () => {
	it("returns a pending request so a renderer that connects later can redraw it", () => {
		const { requestId } = createAgentRequest("complete", "task-1", "proj-1", {
			dialog: { taskTitle: "Ship the thing", subject: SUBJECT },
		});

		expect(listPendingAgentRequests("complete")).toEqual([
			{ requestId, taskId: "task-1", projectId: "proj-1", dialog: { taskTitle: "Ship the thing", subject: SUBJECT } },
		]);
	});

	it("stops returning a request once it is answered", () => {
		const { requestId } = createAgentRequest("complete", "task-1", "proj-1", {
			dialog: { taskTitle: "Ship the thing", subject: SUBJECT },
		});
		resolveAgentRequest(requestId, { approved: false });

		expect(listPendingAgentRequests("complete")).toEqual([]);
	});

	it("keeps a joined retry to ONE entry, so the reconnecting renderer draws one dialog", () => {
		const first = createAgentRequest("complete", "task-1", "proj-1", {
			dialog: { taskTitle: "Ship the thing", subject: SUBJECT },
		});
		const retry = createAgentRequest("complete", "task-1", "proj-1", {
			dialog: { taskTitle: "Ship the thing", subject: SUBJECT },
		});

		expect(retry.isNew).toBe(false);
		expect(listPendingAgentRequests("complete")).toHaveLength(1);
		expect(listPendingAgentRequests("complete")[0].requestId).toBe(first.requestId);
	});

	it("does not mix the kinds", () => {
		createAgentRequest("complete", "task-1", "proj-1", { dialog: { taskTitle: "A", subject: SUBJECT } });
		createAgentRequest("launch", "task-2", "proj-1", { dialog: { taskTitle: "B", subject: SUBJECT } });

		expect(listPendingAgentRequests("complete").map((r) => r.taskId)).toEqual(["task-1"]);
		expect(listPendingAgentRequests("launch").map((r) => r.taskId)).toEqual(["task-2"]);
	});

	it("omits a request created without a dialog — there would be nothing to draw", () => {
		createAgentRequest("complete", "task-1", "proj-1");

		expect(listPendingAgentRequests("complete")).toEqual([]);
	});
});
