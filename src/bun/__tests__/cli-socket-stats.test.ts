import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchRequest, TaskDialogSubject } from "../../shared/types";

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
	setAgentLaunchDialog,
} from "../agent-requests";

const SUBJECT: TaskDialogSubject = { seqLabel: "42", projectName: "Proj", priority: "P3", labels: [], overview: null };

function launchDialog(requestId: string, overrides: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest {
	return {
		requestId, taskId: "task-b", projectId: "proj-1", taskTitle: "Launch me", targetStatus: "in-progress",
		scratch: false, requesterSeq: 7, requesterTitle: "Coordinator", subject: { ...SUBJECT, seqLabel: "43" },
		...overrides,
	} as AgentLaunchRequest;
}

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
	it("is empty with nothing pending", async () => {
		expect(await statsHandlers["approvals.list"]({})).toEqual({ requests: [] });
	});

	it("lists every pending kind with its dialog context, oldest first, and drops settled ones", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			createAgentRequest("complete", "task-a", "proj-1", { dialog: { taskTitle: "Finish me", subject: SUBJECT } });
			vi.setSystemTime(2_000);
			const launch = createAgentRequest("launch", "task-b", "proj-1", { autoApproveAfterMs: 60_000 });
			setAgentLaunchDialog(launchDialog(launch.requestId));
			vi.setSystemTime(3_000);
			const gone = createAgentRequest("cancel", "task-c", "proj-2", { dialog: { taskTitle: "Gone", subject: SUBJECT } });
			resolveAgentRequest(gone.requestId, { approved: false });

			const { requests } = await statsHandlers["approvals.list"]({}) as { requests: Array<Record<string, unknown>> };
			expect(requests).toEqual([
				expect.objectContaining({
					kind: "complete", taskId: "task-a", taskTitle: "Finish me", seqLabel: "42", projectName: "Proj",
					requesterSeq: null, createdAt: 1_000, autoApproveAt: null, heldByUser: false,
				}),
				expect.objectContaining({
					kind: "launch", requestId: launch.requestId, taskTitle: "Launch me", seqLabel: "43",
					requesterSeq: 7, requesterTitle: "Coordinator", requesterSenderId: null,
					createdAt: 2_000, autoApproveAt: 62_000, heldByUser: false,
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("names an external sender instead of a requester task, and reports a held dialog", async () => {
		const launch = createAgentRequest("launch", "task-b", "proj-1", { autoApproveAfterMs: 60_000 });
		setAgentLaunchDialog(launchDialog(launch.requestId, { requesterSender: { senderId: "openclaw", label: "OpenClaw" } }));
		holdAgentRequestAutoApprove(launch.requestId);

		const { requests } = await statsHandlers["approvals.list"]({}) as { requests: Array<Record<string, unknown>> };
		expect(requests[0]).toMatchObject({ requesterSenderId: "openclaw", requesterSeq: null, requesterTitle: null, heldByUser: true });
	});

	it("reports a launch whose dialog payload has not arrived yet with null context, not a crash", async () => {
		createAgentRequest("launch", "task-b", "proj-1");
		const { requests } = await statsHandlers["approvals.list"]({}) as { requests: Array<Record<string, unknown>> };
		expect(requests[0]).toMatchObject({ kind: "launch", taskTitle: null, seqLabel: null, projectName: null });
	});
});
