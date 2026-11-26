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
	markAgentRequestShown,
	holdAgentRequestAutoApprove,
	getAgentRequestState,
	joinAgentRequest,
	AGENT_REQUEST_OUTCOME_TTL_MS,
	voidAgentRequestsForTask,
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
	it("joins the pending request for the same task and kind, and starts a fresh one per kind, task or after resolution", () => {
		const first = createAgentRequest("complete", "task-1", "proj-1");
		const joined = createAgentRequest("complete", "task-1", "proj-1");
		expect(joined.requestId, "same task + kind joins").toBe(first.requestId);
		expect(joined.decision).toBe(first.decision);
		expect(createAgentRequest("complete", "task-2", "proj-1").requestId, "other task").not.toBe(first.requestId);
		expect(createAgentRequest("launch", "task-1", "proj-1").requestId, "other kind").not.toBe(first.requestId);

		resolveAgentRequest(first.requestId, { approved: false });
		expect(createAgentRequest("complete", "task-1", "proj-1").requestId, "after resolution").not.toBe(first.requestId);
	});
});

describe("resolveAgentRequest", () => {
	it("resolves the decision promise with the answer, launch choice included", async () => {
		const approved = createAgentRequest("complete", "task-1", "proj-1");
		const declined = createAgentRequest("complete", "task-2", "proj-1");
		const picked = createAgentRequest("launch", "task-1", "proj-1");
		const launch = { variants: [{ agentId: "builtin-claude", configId: "claude-auto", accountId: null }] };

		expect(resolveAgentRequest(approved.requestId, { approved: true })).toBe(true);
		expect(resolveAgentRequest(declined.requestId, { approved: false })).toBe(true);
		resolveAgentRequest(picked.requestId, { approved: true, launch });
		await expect(approved.decision).resolves.toEqual({ approved: true });
		await expect(declined.decision).resolves.toEqual({ approved: false });
		await expect(picked.decision).resolves.toEqual({ approved: true, launch });
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

	it("returns false and broadcasts nothing for an unknown or already-resolved request", () => {
		const { requestId } = createAgentRequest("complete", "task-1", "proj-1");
		expect(resolveAgentRequest(requestId, { approved: false })).toBe(true);
		push.mockClear();

		expect(resolveAgentRequest(requestId, { approved: false }), "twice").toBe(false);
		expect(resolveAgentRequest("nope", { approved: false }), "unknown").toBe(false);
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

	it("launches with the pick the dialog last reported, and ignores a pick for an unknown request", async () => {
		vi.useFakeTimers();
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});
		const launch = { variants: [{ agentId: "builtin-codex", configId: "codex-default", accountId: null }] };

		expect(setAgentRequestLaunchChoice(requestId, launch)).toBe(true);
		expect(setAgentRequestLaunchChoice("nope", { variants: [{ agentId: null, configId: null }] })).toBe(false);
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

		expect(retry.autoApproveAt).toBe(first.autoApproveAt);
	});

});

// A dialog lives only as a promise inside a renderer, and the push that draws it
// fires once. Without this list, a renderer that reloads before answering leaves
// the request alive and unanswerable for the rest of the app session, because a
// retrying agent joins the same entry instead of triggering a second push.
describe("listPendingAgentRequests", () => {
	it("returns a pending request so a renderer that connects later can redraw it, until it is answered", () => {
		const { requestId } = createAgentRequest("complete", "task-1", "proj-1", {
			dialog: { taskTitle: "Ship the thing", subject: SUBJECT },
		});

		expect(listPendingAgentRequests("complete")).toEqual([
			{ requestId, taskId: "task-1", projectId: "proj-1", dialog: { taskTitle: "Ship the thing", subject: SUBJECT } },
		]);
		resolveAgentRequest(requestId, { approved: false });
		expect(listPendingAgentRequests("complete")).toEqual([]);
	});

	it("keeps a joined retry to ONE entry, does not mix kinds, and omits a request with no dialog to draw", () => {
		const first = createAgentRequest("complete", "task-1", "proj-1", {
			dialog: { taskTitle: "Ship the thing", subject: SUBJECT },
		});
		createAgentRequest("complete", "task-1", "proj-1", { dialog: { taskTitle: "Ship the thing", subject: SUBJECT } });
		createAgentRequest("launch", "task-2", "proj-1", { dialog: { taskTitle: "B", subject: SUBJECT } });
		createAgentRequest("complete", "task-3", "proj-1");

		expect(listPendingAgentRequests("complete").map((r) => r.requestId)).toEqual([first.requestId]);
		expect(listPendingAgentRequests("launch").map((r) => r.taskId)).toEqual(["task-2"]);
	});
});

describe("the countdown measures time the user was actually given", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("restarts the timer when a queued dialog finally reaches the screen", async () => {
		// Dialogs queue rather than stack. This one waits behind another for most
		// of its delay, and would otherwise approve itself the moment it appeared.
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 5 * 60_000,
		});
		let settled = false;
		void decision.then(() => { settled = true; });

		vi.advanceTimersByTime(4 * 60_000 + 59_000);
		markAgentRequestShown(requestId);

		// The original deadline passes with the dialog freshly on screen.
		vi.advanceTimersByTime(2_000);
		await Promise.resolve();
		expect(settled).toBe(false);

		vi.advanceTimersByTime(5 * 60_000);
		await Promise.resolve();
		expect(settled).toBe(true);
	});

	it("hands back the deadline it will actually fire on, so the countdown agrees", () => {
		const { requestId, autoApproveAt } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});
		vi.advanceTimersByTime(30_000);
		const shown = markAgentRequestShown(requestId);
		expect(shown).toBeGreaterThan(autoApproveAt!);
		expect(shown! - Date.now()).toBe(60_000);
	});

	it("only restarts once, so a reloading window cannot postpone a launch forever", async () => {
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});
		let settled = false;
		void decision.then(() => { settled = true; });

		markAgentRequestShown(requestId);
		for (let i = 0; i < 5; i += 1) {
			vi.advanceTimersByTime(10_000);
			markAgentRequestShown(requestId);
		}
		vi.advanceTimersByTime(11_000);
		await Promise.resolve();
		expect(settled).toBe(true);
	});

	it("keeps the original deadline for a request no client ever draws, and invents none for a request without a timer", async () => {
		// A closed window must not be able to stall the requesting agent.
		const { decision } = createAgentRequest("launch", "task-1", "proj-1", { autoApproveAfterMs: 60_000 });
		let settled = false;
		void decision.then(() => { settled = true; });
		vi.advanceTimersByTime(61_000);
		await Promise.resolve();
		expect(settled).toBe(true);

		const { requestId } = createAgentRequest("launch", "task-2", "proj-1");
		expect(markAgentRequestShown(requestId)).toBeNull();
	});
});

// The countdown exists for an absent user. Once somebody touches the dialog, a
// launch that fires on its own happens behind the back of the person reading it.
describe("a user taking the dialog over", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("never auto-approves again, however long the dialog stays open, and tells the other windows to stop", async () => {
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});
		let settled = false;
		void decision.then(() => { settled = true; });

		expect(holdAgentRequestAutoApprove(requestId)).toBe(true);
		expect(push).toHaveBeenCalledWith("agentLaunchAutoApproveHeld", { requestId });
		vi.advanceTimersByTime(24 * 60 * 60_000);
		await Promise.resolve();

		expect(settled).toBe(false);
	});

	it("cannot be re-armed by a dialog reporting itself on screen", async () => {
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});
		let settled = false;
		void decision.then(() => { settled = true; });

		holdAgentRequestAutoApprove(requestId);
		// A second window drawing the same dialog, or the first one reloading.
		expect(markAgentRequestShown(requestId)).toBeNull();
		vi.advanceTimersByTime(10 * 60_000);
		await Promise.resolve();

		expect(settled).toBe(false);
	});

	it("cannot be re-armed by the agent retrying its request", async () => {
		const { requestId, decision } = createAgentRequest("launch", "task-1", "proj-1", {
			autoApproveAfterMs: 60_000,
		});
		let settled = false;
		void decision.then(() => { settled = true; });

		holdAgentRequestAutoApprove(requestId);
		const retry = createAgentRequest("launch", "task-1", "proj-1", { autoApproveAfterMs: 60_000 });
		expect(retry.autoApproveAt).toBeNull();
		vi.advanceTimersByTime(10 * 60_000);
		await Promise.resolve();

		expect(settled).toBe(false);
	});

	it("still answers the blocked agent when the user finally clicks Launch or Decline", async () => {
		const launched = createAgentRequest("launch", "task-1", "proj-1", { autoApproveAfterMs: 60_000 });
		const declined = createAgentRequest("launch", "task-2", "proj-1", { autoApproveAfterMs: 60_000 });
		const launch = { variants: [{ agentId: "builtin-claude", configId: "claude-auto" }] };

		holdAgentRequestAutoApprove(launched.requestId);
		holdAgentRequestAutoApprove(declined.requestId);
		vi.advanceTimersByTime(5 * 60_000);
		resolveAgentRequest(launched.requestId, { approved: true, launch });
		resolveAgentRequest(declined.requestId, { approved: false });

		await expect(launched.decision).resolves.toEqual({ approved: true, launch });
		await expect(declined.decision).resolves.toEqual({ approved: false });
	});

	it("says nothing happened for a request that had no deadline, or none at all", () => {
		const { requestId } = createAgentRequest("launch", "task-1", "proj-1");

		expect(holdAgentRequestAutoApprove(requestId)).toBe(false);
		expect(holdAgentRequestAutoApprove("unknown-id")).toBe(false);
		expect(push).not.toHaveBeenCalledWith("agentLaunchAutoApproveHeld", expect.anything());
	});
});

// What a CLI that lost its socket asks. The states must stay distinct: pending
// is not answered, a decline is not an approval, and "no record" is neither.
describe("getAgentRequestState / joinAgentRequest", () => {
	it("reports pending, then the answer, per kind and task", () => {
		expect(getAgentRequestState("cancel", "task-1")).toEqual({ state: "none" });
		const { requestId } = createAgentRequest("cancel", "task-1", "proj-1");
		expect(getAgentRequestState("cancel", "task-1")).toEqual({ state: "pending", requestId });
		expect(getAgentRequestState("complete", "task-1")).toEqual({ state: "none" });

		resolveAgentRequest(requestId, { approved: false });
		expect(getAgentRequestState("cancel", "task-1")).toMatchObject({ state: "answered", requestId, approved: false });
	});

	it("forgets an answer after the TTL and when a new request for the task starts", () => {
		const first = createAgentRequest("complete", "task-1", "proj-1");
		resolveAgentRequest(first.requestId, { approved: true });
		const answered = getAgentRequestState("complete", "task-1");
		expect(answered).toMatchObject({ state: "answered", approved: true });
		const resolvedAt = (answered as { resolvedAt: number }).resolvedAt;
		expect(getAgentRequestState("complete", "task-1", resolvedAt + AGENT_REQUEST_OUTCOME_TTL_MS + 1)).toEqual({ state: "none" });

		const again = createAgentRequest("complete", "task-2", "proj-1");
		resolveAgentRequest(again.requestId, { approved: false });
		const next = createAgentRequest("complete", "task-2", "proj-1");
		expect(getAgentRequestState("complete", "task-2")).toEqual({ state: "pending", requestId: next.requestId });
	});

	it("joins only a live request and never creates one", () => {
		expect(joinAgentRequest("cancel", "task-1")).toBeNull();
		expect(listPendingAgentRequests("cancel")).toEqual([]);

		const created = createAgentRequest("cancel", "task-1", "proj-1", { dialog: { taskTitle: "T", subject: SUBJECT } });
		const joined = joinAgentRequest("cancel", "task-1");
		expect(joined?.requestId).toBe(created.requestId);
		expect(joined?.decision).toBe(created.decision);
		expect(listPendingAgentRequests("cancel")).toHaveLength(1);

		resolveAgentRequest(created.requestId, { approved: false });
		expect(joinAgentRequest("cancel", "task-1")).toBeNull();
	});
});

describe("voidAgentRequestsForTask", () => {
	it("voids every kind pending for the task — completion and cancellation included — and closes their dialogs", async () => {
		voidAgentRequestsForTask("task-1");
		expect(push, "no-op with nothing pending").not.toHaveBeenCalled();

		const kinds = ["complete", "cancel", "reset", "launch"] as const;
		const requests = kinds.map((kind) => createAgentRequest(kind, "task-1", "proj-1"));
		const other = createAgentRequest("complete", "task-2", "proj-1");

		voidAgentRequestsForTask("task-1");

		for (const { decision } of requests) expect(await decision).toEqual({ approved: false, stale: true });
		const closed = push.mock.calls.filter(([event]) => event === "agentRequestResolved").map(([, p]) => p.requestId);
		expect(closed.sort()).toEqual(requests.map((r) => r.requestId).sort());
		expect(getAgentRequestState("complete", "task-2")).toEqual({ state: "pending", requestId: other.requestId });
	});
});
