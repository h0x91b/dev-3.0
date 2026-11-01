import { beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-mcp-start-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { writeFileSync } from "node:fs";
import type { CliResponse, Project, Task } from "../../shared/types";
import { MCP_TOOLS, _resetMcpStartsForTests, findTool, runTool, type ToolContext } from "../mcp/tools";
import type { McpTokenRecord } from "../mcp/token-store";
import { senderAutoApproveMs } from "../cli-session-approval";
import { senderRequester } from "../cli-socket/task-resolution";

const PROJECT = { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "A", path: "/a" } as Project;
const TODO = { id: "aaaaaaaa-task-0000-0000-000000000001", seq: 7, projectId: PROJECT.id, status: "todo", title: "t" } as Task;
const RUNNING = { id: "aaaaaaaa-task-0000-0000-000000000002", seq: 8, projectId: PROJECT.id, status: "in-progress", title: "r" } as Task;
const SENDER = "openclaw:home:main";

function token(overrides: Partial<McpTokenRecord> = {}): McpTokenRecord {
	return {
		id: "3fa9c0d1", sha256: "0".repeat(64), sender: SENDER, scopes: ["read", "stats", "send", "write", "start", "content"],
		projects: [PROJECT.id], autoApprove: false, label: null, createdAt: "", expiresAt: null, revokedAt: null, ...overrides,
	};
}

let calls: Array<{ method: string; params: Record<string, unknown> }>;
let pending: Array<Record<string, unknown>>;
let moveResult: Promise<CliResponse>;

function ctx(t = token()): ToolContext {
	return {
		token: t, senderLabel: "Main", approvalWaitMs: 20,
		call: async (method, params) => {
			calls.push({ method, params });
			const okData = (data: unknown): CliResponse => ({ id: "x", ok: true, data });
			switch (method) {
				case "projects.list": return okData([PROJECT]);
				case "tasks.list": return okData([TODO, RUNNING]);
				case "approvals.list": return okData({ requests: pending });
				case "task.moveAsSender": return moveResult;
				case "agent.resumeAsSender": return okData({ outcome: "already-running", taskId: RUNNING.id, seq: 8, backend: "tmux" });
				case "task.create": return okData({ ...TODO, title: params.title });
				case "task.update": return okData({ task: { ...TODO, priority: params.priority } });
				case "task.show": return okData(TODO);
				case "task.peek": return okData({ text: "" });
				case "sender.wait": return okData({ items: [], cursor: null, more: false });
				case "sender.ack": return okData({ acked: [], unknown: [] });
				case "message.sendAsSender": return okData({ status: "queued", messageId: "m" });
				case "stats.productivity": return okData({ generatedAt: "", events: [] });
				case "stats.limits": return okData({ generatedAt: 0, snapshots: [] });
				case "stats.prices": return okData({ fetchedAt: null, models: [] });
				case "events.list": return okData({ events: [], cursor: null });
				case "ui.state": return okData({});
				case "spaces.list": return okData({ spaces: [], order: [] });
				default: return okData({});
			}
		},
	};
}

beforeEach(() => {
	calls = [];
	pending = [];
	moveResult = Promise.resolve({ id: "x", ok: true, data: { approved: true, seq: 7, title: "t", launched: [] } });
	_resetMcpStartsForTests();
	writeFileSync(`${home}/external-senders.json`, JSON.stringify({ senders: { [SENDER]: { label: "Main" } } }));
});

const run = (name: string, args: Record<string, unknown>, c = ctx()) => runTool(findTool(name)!, args, c);
const count = (m: string) => calls.filter((c) => c.method === m).length;

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
	whoami: {}, projects_list: {}, tasks_list: { project: PROJECT.id }, task_show: { task: "seq:7" }, events_list: {},
	approvals_list: {}, ui_state: {}, stats_get: { kind: "productivity" }, stats_prices: { models: ["m"] },
	message_send: { task: "seq:7", subject: "s", text: "t" }, inbox_wait: { clientId: "c" }, inbox_ack: { clientId: "c", ids: ["i"] },
	task_create: { project: PROJECT.id, title: "x" }, task_set_priority: { task: "seq:7", priority: "P1" },
	task_start: { task: "seq:7" }, agent_resume: { task: "seq:8" }, task_peek: { task: "seq:8" },
	conversations_search: { query: "x", project: PROJECT.id },
};

describe("the tool table only reaches allowed handlers", () => {
	const ALLOWED = new Set([
		"projects.list", "spaces.list", "tasks.list", "task.show", "events.list", "approvals.list", "ui.state",
		"stats.productivity", "stats.usage", "stats.taskUsage", "stats.limits", "stats.memory", "stats.prices",
		"message.sendAsSender", "sender.wait", "sender.ack", "task.create", "task.update", "task.moveAsSender",
		"agent.resumeAsSender", "task.peek",
	]);

	it("walks every tool and finds no plain move/resume/send, no spawn, no completion, no pane input", async () => {
		for (const tool of MCP_TOOLS) {
			expect(SAMPLE_ARGS[tool.name], `sample args for ${tool.name}`).toBeDefined();
			await runTool(tool, SAMPLE_ARGS[tool.name], ctx());
		}
		const reached = new Set(calls.map((c) => c.method));
		expect([...reached].filter((m) => !ALLOWED.has(m))).toEqual([]);
		for (const c of calls.filter((c) => /AsSender$/.test(c.method))) expect(c.params.asSender).toBe(SENDER);
	});
});

describe("task_start", () => {
	it("never asks for auto-approve unless the token opted in", async () => {
		await run("task_start", { task: "seq:7" });
		expect(calls.find((c) => c.method === "task.moveAsSender")?.params).toMatchObject({ interactiveOnly: true, viaTokenId: "3fa9c0d1", newStatus: "in-progress" });
		_resetMcpStartsForTests();
		calls = [];
		await run("task_start", { task: "seq:7" }, ctx(token({ autoApprove: true })));
		expect(calls.find((c) => c.method === "task.moveAsSender")?.params.interactiveOnly).toBeUndefined();
	});

	it("answers 25 while the dialog is open, and a re-call joins instead of asking again", async () => {
		let answer!: (r: CliResponse) => void;
		moveResult = new Promise((resolve) => (answer = resolve));
		pending = [{ kind: "launch", taskId: TODO.id, requestId: "req-1", autoApproveAt: null, requesterSenderId: SENDER }];
		const first = await run("task_start", { task: "seq:7" });
		expect(first.exitCode).toBe(25);
		expect(first.json).toEqual({ pending: true, requestId: "req-1", autoApproveAt: null });
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(25);
		answer({ id: "x", ok: true, data: { approved: true, seq: 7, title: "t", launched: [{ variantIndex: null, replyCommand: "c" }] } });
		const done = await run("task_start", { task: "seq:7" });
		expect(done).toMatchObject({ exitCode: 0, json: { schemaVersion: 1, approved: true, seq: 7 } });
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(0);
		expect(count("task.moveAsSender")).toBe(1);
	});

	it("reports a decline as exit 10, and remembers it rather than asking again", async () => {
		moveResult = Promise.resolve({ id: "x", ok: true, data: { approved: false } });
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(10);
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(10);
		expect(count("task.moveAsSender")).toBe(1);
	});

	it("answers alreadyActive for a running task without opening a dialog", async () => {
		const out = await run("task_start", { task: "seq:8" });
		expect(out).toEqual({ exitCode: 0, json: { schemaVersion: 1, alreadyActive: true, task: { id: RUNNING.id, seq: 8, status: "in-progress" } } });
		expect(count("task.moveAsSender")).toBe(0);
	});

	it("caps open dialogs per sender", async () => {
		pending = [1, 2, 3].map((i) => ({ kind: "launch", taskId: `other-${i}`, requesterSenderId: SENDER }));
		const out = await run("task_start", { task: "seq:7" });
		expect(out.error?.code).toBe("TOO_MANY_PENDING");
		expect(count("task.moveAsSender")).toBe(0);
	});
});

describe("agent_resume", () => {
	it("goes through agent.resumeAsSender, interactive only, and treats already-running as success 31", async () => {
		const out = await run("agent_resume", { task: "seq:8" });
		expect(out.exitCode).toBe(31);
		expect(findTool("agent_resume")!.successCodes).toContain(31);
		expect(calls.find((c) => c.method === "agent.resumeAsSender")?.params).toMatchObject({ asSender: SENDER, interactiveOnly: true });
	});
});

describe("task_create", () => {
	it("cannot name a PR or branch (that would fetch fork code on the host)", async () => {
		for (const extra of [{ pr: "12" }, { branch: "origin/x" }]) {
			expect((await run("task_create", { project: PROJECT.id, title: "x", ...extra })).exitCode).toBe(3);
		}
		expect(count("task.create")).toBe(0);
	});
});

describe("the approval side", () => {
	it("carries interactiveOnly into the requester, where it zeroes auto-approve", () => {
		const requester = senderRequester({ asSender: SENDER, interactiveOnly: true, viaTokenId: "3fa9c0d1" })!;
		expect(requester).toEqual({ senderId: SENDER, label: "Main", interactiveOnly: true, viaTokenId: "3fa9c0d1" });
		expect(senderAutoApproveMs(requester, 60_000)).toBe(0);
		expect(senderAutoApproveMs(senderRequester({ asSender: SENDER })!, 60_000)).toBe(60_000);
	});

	it("drops a malformed token id rather than rendering it in the dialog", () => {
		expect(senderRequester({ asSender: SENDER, viaTokenId: "<b>x</b>" })!.viaTokenId).toBeUndefined();
	});
});
