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
let TODO = { id: "aaaaaaaa-task-0000-0000-000000000001", seq: 7, projectId: PROJECT.id, status: "todo", title: "t" } as Task;
const RUNNING = { id: "aaaaaaaa-task-0000-0000-000000000002", seq: 8, projectId: PROJECT.id, status: "in-progress", title: "r" } as Task;
const SENDER = "openclaw:home:main";
const EXTRA_TODOS = [10, 11, 12, 13].map((seq) => ({ id: `aaaaaaaa-todo-0000-0000-0000000000${seq}`, seq, projectId: PROJECT.id, status: "todo", title: "x" } as Task));

function token(overrides: Partial<McpTokenRecord> = {}): McpTokenRecord {
	return {
		id: "3fa9c0d1", sha256: "0".repeat(64), sender: SENDER, scopes: ["read", "stats", "send", "write", "start", "content"],
		projects: [PROJECT.id], autoApprove: false, label: null, createdAt: "", expiresAt: null, revokedAt: null, ...overrides,
	};
}

let calls: Array<{ method: string; params: Record<string, unknown> }>;
let pending: Array<Record<string, unknown>>;
let moveResult: Promise<CliResponse>;
let resumeResult: Record<string, unknown>;

function ctx(t = token()): ToolContext {
	return {
		token: t, senderLabel: "Main", approvalWaitMs: 20,
		call: async (method, params) => {
			calls.push({ method, params });
			const okData = (data: unknown): CliResponse => ({ id: "x", ok: true, data });
			switch (method) {
				case "projects.list": return okData([PROJECT]);
				case "tasks.list": return okData([TODO, RUNNING, ...EXTRA_TODOS]);
				case "approvals.list": return okData({ requests: pending });
				case "task.moveAsSender": return moveResult;
				case "agent.resumeAsSender": return okData(resumeResult);
				case "task.createAsSender": return okData({ ...TODO, title: params.title });
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
	resumeResult = { outcome: "already-running", taskId: RUNNING.id, seq: 8, backend: "tmux" };
	moveResult = Promise.resolve({ id: "x", ok: true, data: { approved: true, seq: 7, title: "t", launched: [] } });
	_resetMcpStartsForTests();
	TODO = { ...TODO, status: "todo" };
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
		"message.sendAsSender", "sender.wait", "sender.ack", "task.createAsSender", "task.update", "task.moveAsSender",
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
	it("puts no approval or origin field in the socket params — the listener passes those out of band", async () => {
		await run("task_start", { task: "seq:7" });
		const params = calls.find((c) => c.method === "task.moveAsSender")!.params;
		expect(params).toEqual({ taskId: TODO.id, projectId: PROJECT.id, newStatus: "in-progress", asSender: SENDER });
	});

	it("starts once when two calls race", async () => {
		moveResult = new Promise(() => {});
		await Promise.all([run("task_start", { task: "seq:7" }), run("task_start", { task: "seq:7" })]);
		expect(count("task.moveAsSender")).toBe(1);
	});

	it("does not replay an approval the board has since undone", async () => {
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(0);
		await run("task_start", { task: "seq:7" });
		expect(count("task.moveAsSender")).toBe(2);
	});

	it("refuses to join a dialog whose countdown would approve it, unless the token may auto-approve", async () => {
		pending = [{ kind: "launch", taskId: TODO.id, requestId: "r", autoApproveAt: "2026-11-01T00:00:00Z", requesterSenderId: null }];
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(1);
		expect(count("task.moveAsSender")).toBe(0);
		await run("task_start", { task: "seq:7" }, ctx(token({ autoApprove: true })));
		expect(count("task.moveAsSender")).toBe(1);
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
		TODO = { ...TODO, status: "in-progress" };
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
		expect(calls.find((c) => c.method === "agent.resumeAsSender")?.params).toEqual({ taskId: RUNNING.id, projectId: PROJECT.id, asSender: SENDER });
	});

	it("hands back a decline given between two polls instead of asking again", async () => {
		resumeResult = { outcome: "declined", taskId: RUNNING.id, seq: 8 };
		expect((await run("agent_resume", { task: "seq:8" })).exitCode).toBe(10);
		expect((await run("agent_resume", { task: "seq:8" })).exitCode).toBe(10);
		expect(count("agent.resumeAsSender")).toBe(1);
	});
});

describe("task_create", () => {
	it("cannot name a PR or branch (that would fetch fork code on the host)", async () => {
		for (const extra of [{ pr: "12" }, { branch: "origin/x" }]) {
			expect((await run("task_create", { project: PROJECT.id, title: "x", ...extra })).exitCode).toBe(3);
		}
		expect(count("task.createAsSender")).toBe(0);
	});
});

describe("the approval side", () => {
	it("carries interactiveOnly into the requester, where it zeroes auto-approve", () => {
		const requester = senderRequester({ asSender: SENDER }, { tokenId: "3fa9c0d1", interactiveOnly: true })!;
		expect(requester).toEqual({ senderId: SENDER, label: "Main", interactiveOnly: true, viaTokenId: "3fa9c0d1" });
		expect(senderAutoApproveMs(requester, 60_000)).toBe(0);
		expect(senderAutoApproveMs(senderRequester({ asSender: SENDER })!, 60_000)).toBe(60_000);
	});

	it("ignores origin fields a local caller puts in the socket params", () => {
		expect(senderRequester({ asSender: SENDER, interactiveOnly: true, viaTokenId: "3fa9c0d1" })).toEqual({ senderId: SENDER, label: "Main" });
	});
});

describe("content scope", () => {
	it("is refused to a token without it", async () => {
		for (const [name, args] of [["task_peek", { task: "seq:8" }], ["conversations_search", { query: "x", project: PROJECT.id }]] as const) {
			const out = await run(name, args, ctx(token({ scopes: ["read", "send", "start"] })));
			expect(out.error?.code, name).toBe("SCOPE_DENIED");
		}
		expect(count("task.peek")).toBe(0);
	});

	it("searches off the host thread and drops transcript paths", async () => {
		const search = vi.fn(async () => [{ taskId: "t", title: "x", status: "completed", agentId: null, score: 1, bodyMatches: 1, metaMatches: 0, snippets: ["s"], transcriptPaths: ["/home/u/.claude/x.jsonl"], lastActivityMs: 1 }]);
		const out = await run("conversations_search", { query: "x", project: PROJECT.id }, { ...ctx(), searchConversations: search as never });
		expect(search).toHaveBeenCalledWith(expect.objectContaining({ projectPath: "/a", query: "x", limit: 5 }), undefined);
		expect(JSON.stringify(out.json)).not.toContain("transcriptPaths");
		expect((out.json as unknown[])).toHaveLength(1);
	});

	it("refuses to search on the host thread when no worker is configured", async () => {
		const { searchProjectConversationsOffThread } = await import("../conversation-search-project");
		await expect(searchProjectConversationsOffThread({ query: "x", projectPath: "/a", currentTaskId: null, allStatuses: false, limit: 1, home, dev3Home: home }))
			.rejects.toThrow(/no search worker/);
	});
});

describe("stats and creation over the network", () => {
	it("refuses all-agent usage (an unbounded main-thread scan) and since where it means nothing", async () => {
		expect((await run("stats_get", { kind: "usage", since: "1d" })).exitCode).toBe(3);
		expect((await run("stats_get", { kind: "limits", since: "1d" })).exitCode).toBe(3);
		expect(count("stats.usage")).toBe(0);
	});

	it("filters limit sessions to the allow-list and drops their config dirs", async () => {
		const c = ctx();
		const base = c.call;
		c.call = async (m, p) => m === "stats.limits"
			? { id: "x", ok: true, data: { generatedAt: 0, snapshots: [], sessions: [
				{ taskId: TODO.id, projectId: PROJECT.id, configDir: "/home/u/.claude", taskTitle: "mine" },
				{ taskId: "elsewhere", projectId: "bbbbbbbb-other", configDir: "/x", taskTitle: "secret" },
			] } }
			: base(m, p);
		const out = await run("stats_get", { kind: "limits" }, c);
		expect((out.json as { sessions: unknown[] }).sessions).toEqual([{ taskId: TODO.id, projectId: PROJECT.id, taskTitle: "mine" }]);
	});

	it("strips other programs' command lines from memory stats", async () => {
		const c = ctx(token({ projects: ["*"] }));
		const base = c.call;
		c.call = async (m, p) => m === "stats.memory"
			? { id: "x", ok: true, data: { topConsumers: [{ name: "app", rss: 1, processCount: 1, path: "/bin/app", cmdline: "app --token=s3cret" }], topTasks: [] } }
			: base(m, p);
		const out = await run("stats_get", { kind: "memory" }, c);
		expect(JSON.stringify(out.json)).not.toContain("s3cret");
	});

	it("cannot create a coordinator (its messages carry the user's authority)", async () => {
		expect((await run("task_create", { project: PROJECT.id, title: "x", type: "coordinator" })).exitCode).toBe(3);
	});

	it("answers the same for a missing project and one outside the list", async () => {
		const missing = await run("tasks_list", { project: "ffffffff-nope" });
		const other = await run("tasks_list", { project: "bbbbbbbb-0000-0000-0000-000000000002" }, ctx(token({ projects: ["someone-else"] })));
		expect(missing.error?.code).toBe("SCOPE_DENIED");
		expect(other.error?.code).toBe("SCOPE_DENIED");
	});
});

describe("coordinator review round 2", () => {
	it("reports an approved start that failed to prepare as exit 46, not success", async () => {
		moveResult = Promise.resolve({ id: "x", ok: true, data: { approved: true, seq: 7, title: "t", launched: [{ variantIndex: null, replyCommand: "c", preparation: { state: "failed", error: "setup script exited 1" } }] } });
		const out = await run("task_start", { task: "seq:7" });
		expect(out.exitCode).toBe(46);
		expect(out.error?.message).toContain("setup script exited 1");
	});

	it("limits productivity and task usage to 6 calls a minute per token, and shares one productivity computation", async () => {
		const c = ctx(token({ projects: ["*"] }));
		const outs = [];
		for (let i = 0; i < 6; i++) outs.push(await run("stats_get", { kind: "productivity" }, c));
		expect(outs.every((o) => o.exitCode === 0)).toBe(true);
		expect(count("stats.productivity")).toBe(1);
		const seventh = await run("stats_get", { kind: "usage", task: "seq:7" }, c);
		expect(seventh.error?.code).toBe("RATE_LIMITED");
		expect(seventh.error?.retryAfterS).toBeGreaterThan(0);
		expect(count("stats.taskUsage")).toBe(0);
	});

	it("runs one transcript search per token at a time and hands it the disconnect signal", async () => {
		let release!: () => void;
		const search = vi.fn((_opts: unknown, _signal?: AbortSignal) => new Promise<never[]>((resolve) => (release = () => resolve([]))));
		const signal = new AbortController().signal;
		const c = { ...ctx(), searchConversations: search as never, signal };
		const first = run("conversations_search", { query: "x", project: PROJECT.id }, c);
		const second = await run("conversations_search", { query: "y", project: PROJECT.id }, c);
		expect(second.error?.code).toBe("RATE_LIMITED");
		release();
		expect((await first).exitCode).toBe(0);
		expect(search.mock.calls[0][1]).toBe(signal);
	});

	it("never replays a decline the user did not give (a voided, stale request)", async () => {
		resumeResult = { outcome: "declined", taskId: RUNNING.id, seq: 8, stale: true };
		await run("agent_resume", { task: "seq:8" });
		resumeResult = { outcome: "already-running", taskId: RUNNING.id, seq: 8, backend: "tmux" };
		expect((await run("agent_resume", { task: "seq:8" })).exitCode).toBe(31);
		expect(count("agent.resumeAsSender")).toBe(2);
	});

	it("answers alreadyActive, not 'declined', once the user started the task by hand", async () => {
		moveResult = Promise.resolve({ id: "x", ok: true, data: { approved: false } });
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(10);
		TODO = { ...TODO, status: "in-progress" };
		expect((await run("task_start", { task: "seq:7" })).json).toMatchObject({ alreadyActive: true });
	});

	it("answers alreadyActive once the user started the task another way, whose start voided the open dialog", async () => {
		let answer!: (r: CliResponse) => void;
		moveResult = new Promise((resolve) => (answer = resolve));
		pending = [{ kind: "launch", taskId: TODO.id, requestId: "req-1", autoApproveAt: null, requesterSenderId: SENDER }];
		expect((await run("task_start", { task: "seq:7" })).exitCode).toBe(25);
		TODO = { ...TODO, status: "in-progress" };
		answer({ id: "x", ok: true, data: { approved: false, stale: true } });
		pending = [];
		expect((await run("task_start", { task: "seq:7" })).json).toMatchObject({ alreadyActive: true });
		expect(count("task.moveAsSender")).toBe(1);
	});

	it("re-checks the board when the dialog it waits on is voided mid-call", async () => {
		moveResult = new Promise((resolve) => setTimeout(() => {
			TODO = { ...TODO, status: "in-progress" };
			resolve({ id: "x", ok: true, data: { approved: false, stale: true } });
		}, 5));
		const out = await run("task_start", { task: "seq:7" });
		expect(out.exitCode).toBe(0);
		expect(out.json).toMatchObject({ alreadyActive: true });
	});

	it("drops a kept answer when the task's run changed", async () => {
		moveResult = Promise.resolve({ id: "x", ok: true, data: { approved: false } });
		await run("task_start", { task: "seq:7" });
		TODO = { ...TODO, lifecycleStartedAt: "2026-11-01T12:00:00Z" } as Task;
		await run("task_start", { task: "seq:7" });
		expect(count("task.moveAsSender")).toBe(2);
	});

	it("counts this sender's in-flight starts toward the dialog cap, not only the snapshot", async () => {
		moveResult = new Promise(() => {});
		const outs = await Promise.all([10, 11, 12, 13].map((seq) => run("task_start", { task: `seq:${seq}` })));
		expect(outs.filter((o) => o.error?.code === "TOO_MANY_PENDING")).toHaveLength(1);
		expect(count("task.moveAsSender")).toBe(3);
	});

	it("hides who asked for a launch when the asker is on another board or is another sender", async () => {
		pending = [
			{ kind: "launch", taskId: TODO.id, projectId: PROJECT.id, requestId: "a", requesterTaskId: "elsewhere", requesterSeq: 4, requesterTitle: "secret", requesterSenderId: null },
			{ kind: "launch", taskId: TODO.id, projectId: PROJECT.id, requestId: "b", requesterTaskId: null, requesterSeq: null, requesterTitle: "Other bot", requesterSenderId: "someone:else" },
			{ kind: "launch", taskId: TODO.id, projectId: PROJECT.id, requestId: "c", requesterTaskId: RUNNING.id, requesterSeq: 8, requesterTitle: "mine", requesterSenderId: null },
		];
		const out = await run("approvals_list", {});
		const rows = (out.json as { requests: Array<Record<string, unknown>> }).requests;
		expect(JSON.stringify(rows)).not.toContain("secret");
		expect(JSON.stringify(rows)).not.toContain("someone:else");
		expect(rows[2]).toMatchObject({ requesterTaskId: RUNNING.id, requesterTitle: "mine" });
	});

	it("names nothing about a parent task on another board", async () => {
		const c = ctx();
		const base = c.call;
		c.call = async (m, p) => m === "task.show"
			? { id: "x", ok: true, data: { ...TODO, origin: { kind: "task", taskId: "parent-elsewhere", projectId: "bbbbbbbb-other" }, originParent: { id: "parent-elsewhere", projectId: "bbbbbbbb-other", projectName: "B", seq: 1, variantIndex: null, title: "secret" } } }
			: base(m, p);
		const out = await run("task_show", { task: "seq:7" }, c);
		expect((out.json as { origin: unknown }).origin).toEqual({ kind: "task", taskId: null, projectId: null, parent: null });
	});

	it("drops config dirs from limit snapshots too", async () => {
		const c = ctx(token({ projects: ["*"] }));
		const base = c.call;
		c.call = async (m, p) => m === "stats.limits"
			? { id: "x", ok: true, data: { generatedAt: 0, snapshots: [{ source: "claude", accountId: null, configDir: "/Users/u/.claude-work", windows: [] }], sessions: [] } }
			: base(m, p);
		expect(JSON.stringify((await run("stats_get", { kind: "limits" }, c)).json)).not.toContain(".claude-work");
	});

	it("creates tasks as the sender, so the origin says who wrote the brief", async () => {
		await run("task_create", { project: PROJECT.id, title: "x", description: "do it" });
		expect(calls.find((c) => c.method === "task.createAsSender")?.params).toMatchObject({ asSender: SENDER, projectId: PROJECT.id });
	});
});

describe("the search worker", () => {
	it("is terminated when the client disconnects", async () => {
		const { mkdtempSync, writeFileSync: write } = await import("node:fs");
		const dir = mkdtempSync(`${require("node:os").tmpdir()}/dev3-search-worker-`);
		const worker = `${dir}/hang.mjs`;
		write(worker, "setInterval(() => {}, 1000);\n");
		const { configureConversationSearchWorker, searchProjectConversationsOffThread } = await import("../conversation-search-project");
		configureConversationSearchWorker(worker);
		try {
			const abort = new AbortController();
			const started = Date.now();
			const pendingSearch = searchProjectConversationsOffThread({ query: "x", projectPath: "/a", currentTaskId: null, allStatuses: false, limit: 1, home, dev3Home: home }, abort.signal);
			setTimeout(() => abort.abort(), 50);
			await expect(pendingSearch).rejects.toThrow(/disconnected/);
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			configureConversationSearchWorker(null);
		}
	});
});
