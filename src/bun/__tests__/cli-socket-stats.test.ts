import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskDialogSubject } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => vi.fn() }));
vi.mock("../rpc-handlers", () => ({
	handlers: {
		getProductivityStats: vi.fn(async () => ({ events: [], generatedAt: "2026-10-27T00:00:00.000Z" })),
		getAgentUsage: vi.fn(async () => ({ days: [], generatedAt: "2026-10-27T00:00:00.000Z", hasUnpricedModels: false, models: [] })),
		getAgentRateLimits: vi.fn(async () => ({ snapshots: [], generatedAt: 1 })),
		getSystemMemory: vi.fn(async () => null),
	},
}));

const OPUS = { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 };
vi.mock("../agent-pricing-refresh", () => ({
	describePricing: vi.fn(async () => ({ fetchedAt: 123, resolve: (id: string) => (id === "claude-opus-5-5" ? OPUS : null) })),
}));
vi.mock("../model-catalog-store", () => ({ loadModelCatalog: vi.fn(() => ({})) }));
vi.mock("../../shared/model-catalog", () => ({
	nativeModelIdForWireName: vi.fn((_catalog: unknown, wire: string) => (wire === "dev3-opus-route" ? "claude-opus-5-5" : undefined)),
}));

vi.mock("../rpc-handlers/agent-usage", () => ({
	getTaskAgentUsage: vi.fn(async (project: { id: string }, task: { id: string }) => ({ projectId: project.id, taskId: task.id })),
}));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskFromParams: vi.fn(async (params: Record<string, unknown>) => ({ project: { id: params.projectId }, task: { id: "t-9" } })),
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
	it("hands stats.usage a string since so the scan can skip old transcripts", async () => {
		await statsHandlers["stats.usage"]({ since: "2026-10-25T00:00:00.000Z" });
		expect(rpc.getAgentUsage).toHaveBeenLastCalledWith({ since: "2026-10-25T00:00:00.000Z" });
		await statsHandlers["stats.usage"]({ since: 7 });
		expect(rpc.getAgentUsage).toHaveBeenLastCalledWith({});
	});


	it("pass the renderer handlers' answers through unchanged", async () => {
		expect(await statsHandlers["stats.productivity"]({})).toEqual({ events: [], generatedAt: "2026-10-27T00:00:00.000Z" });
		expect(await statsHandlers["stats.usage"]({})).toMatchObject({ days: [], hasUnpricedModels: false });
		expect(await statsHandlers["stats.limits"]({})).toEqual({ snapshots: [], generatedAt: 1 });
		expect(await statsHandlers["stats.memory"]({})).toBeNull();
		expect(await statsHandlers["stats.taskUsage"]({ taskId: "seq:9", projectId: "p-1" })).toEqual({ projectId: "p-1", taskId: "t-9" });
		expect(rpc.getAgentUsage).toHaveBeenCalledWith({});
		expect(rpc.getProductivityStats).toHaveBeenCalledTimes(1);
		expect(rpc.getSystemMemory).toHaveBeenCalledTimes(1);
	});
});

describe("stats.prices", () => {
	it("prices the requested ids, a catalog wire name as its native model, unknown as null", async () => {
		expect(await statsHandlers["stats.prices"]({ models: ["dev3-opus-route", "claude-opus-5-5", "mystery"] })).toEqual({
			fetchedAt: 123,
			models: [
				{ model: "dev3-opus-route", rate: OPUS },
				{ model: "claude-opus-5-5", rate: OPUS },
				{ model: "mystery", rate: null },
			],
		});
		expect(rpc.getAgentUsage).not.toHaveBeenCalled();
	});

	it("with no ids, prices every model local usage has seen", async () => {
		vi.mocked(rpc.getAgentUsage).mockResolvedValueOnce({ days: [], generatedAt: "G", hasUnpricedModels: true, models: ["claude-opus-5-5", "mystery"] });
		expect(await statsHandlers["stats.prices"]({})).toEqual({
			fetchedAt: 123, models: [{ model: "claude-opus-5-5", rate: OPUS }, { model: "mystery", rate: null }],
		});
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
