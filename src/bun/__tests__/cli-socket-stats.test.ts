import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskDialogSubject } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => vi.fn() }));
vi.mock("../rpc-handlers", () => ({
	handlers: {
		getProductivityStats: vi.fn(async () => ({ events: [], generatedAt: "2026-10-27T00:00:00.000Z" })),
		getAgentUsage: vi.fn(async () => ({ days: [], generatedAt: "2026-10-27T00:00:00.000Z", hasUnpricedModels: false })),
		getAgentRateLimits: vi.fn(async () => ({ snapshots: [], generatedAt: 1 })),
		getSystemMemory: vi.fn(async () => null),
	},
}));

import { statsHandlers } from "../cli-socket/stats-commands";
import { handlers as rpc } from "../rpc-handlers";
import {
	_resetAgentRequestsForTests,
	createAgentRequest,
	holdAgentRequestAutoApprove,
	resolveAgentRequest,
} from "../agent-requests";

const SUBJECT: TaskDialogSubject = { seqLabel: "42", projectName: "Proj", priority: "P3", labels: [], overview: null };

beforeEach(() => {
	_resetAgentRequestsForTests();
	vi.clearAllMocks();
});

describe("stats.* socket methods", () => {
	it("pass the renderer handlers' answers through unchanged", async () => {
		expect(await statsHandlers["stats.productivity"]({})).toEqual({ events: [], generatedAt: "2026-10-27T00:00:00.000Z" });
		expect(await statsHandlers["stats.usage"]({})).toMatchObject({ days: [], hasUnpricedModels: false });
		expect(await statsHandlers["stats.limits"]({})).toEqual({ snapshots: [], generatedAt: 1 });
		expect(await statsHandlers["stats.memory"]({})).toBeNull();
		expect(rpc.getProductivityStats).toHaveBeenCalledTimes(1);
		expect(rpc.getSystemMemory).toHaveBeenCalledTimes(1);
	});
});

describe("approvals.list", () => {
	const asker = { taskId: "task-r", seq: 7, title: "Coordinator", senderId: null };

	it("is empty with nothing pending", async () => {
		expect(await statsHandlers["approvals.list"]({})).toEqual({ requests: [] });
	});

	it("lists every pending kind with its dialog context, oldest first, and drops settled ones", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			createAgentRequest("complete", "task-a", "proj-1", { dialog: { taskTitle: "Finish me", subject: SUBJECT } });
			vi.setSystemTime(2_000);
			const launch = createAgentRequest("launch", "task-b", "proj-1", {
				autoApproveAfterMs: 60_000,
				dialog: { taskTitle: "Launch me", subject: { ...SUBJECT, seqLabel: "43" }, requester: asker },
			});
			vi.setSystemTime(3_000);
			const gone = createAgentRequest("cancel", "task-c", "proj-2", { dialog: { taskTitle: "Gone", subject: SUBJECT } });
			resolveAgentRequest(gone.requestId, { approved: false });

			const { requests } = await statsHandlers["approvals.list"]({}) as { requests: Array<Record<string, unknown>> };
			expect(requests).toEqual([
				expect.objectContaining({
					kind: "complete", taskId: "task-a", taskTitle: "Finish me", seqLabel: "42", projectName: "Proj",
					requesterSeq: null, createdAt: new Date(1_000).toISOString(), autoApproveAt: null, heldByUser: false,
				}),
				expect.objectContaining({
					kind: "launch", requestId: launch.requestId, taskTitle: "Launch me", seqLabel: "43",
					requesterTaskId: "task-r", requesterSeq: 7, requesterTitle: "Coordinator", requesterSenderId: null,
					createdAt: new Date(2_000).toISOString(), autoApproveAt: new Date(62_000).toISOString(), heldByUser: false,
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("names an external sender instead of a requester task, and reports a held dialog", async () => {
		const launch = createAgentRequest("launch", "task-b", "proj-1", {
			autoApproveAfterMs: 60_000,
			dialog: { taskTitle: "Launch me", subject: SUBJECT, requester: { taskId: null, seq: null, title: "OpenClaw", senderId: "openclaw" } },
		});
		holdAgentRequestAutoApprove(launch.requestId);

		const { requests } = await statsHandlers["approvals.list"]({}) as { requests: Array<Record<string, unknown>> };
		expect(requests[0]).toMatchObject({ requesterSenderId: "openclaw", requesterTaskId: null, requesterSeq: null, heldByUser: true, autoApproveAt: null });
	});

	it("reports a request created without dialog context as nulls, not a crash", async () => {
		createAgentRequest("launch", "task-b", "proj-1");
		const { requests } = await statsHandlers["approvals.list"]({}) as { requests: Array<Record<string, unknown>> };
		expect(requests[0]).toMatchObject({ kind: "launch", taskTitle: null, seqLabel: null, projectName: null, requesterTaskId: null });
	});
});
