import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-mcp-home-`) as string);
const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("../paths", () => ({ DEV3_HOME: home }));
vi.mock("../logger", () => ({
	createLogger: () => {
		const record = (...args: unknown[]) => void logged.push(args);
		return { debug: record, info: record, warn: record, error: record };
	},
}));

import type { CliRequest, CliResponse, Project, Task } from "../../shared/types";
import { CLI_EXIT_CODE_DEFINITIONS } from "../../shared/cli-exit-codes";
import { _resetAuthRateLimitForTests } from "../remote-auth-rate-limit";
import { createMcpHandler } from "../mcp/server";
import { MCP_TOOLS } from "../mcp/tools";
import { McpConfigCache, generateMcpToken, type McpScope, type McpTokenRecord } from "../mcp/token-store";

const PROJECT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const PROJECT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const PROJECTS: Project[] = [
	{ id: PROJECT_A, name: "A", path: "/repo/a", defaultBaseBranch: "main" } as Project,
	{ id: PROJECT_B, name: "B", path: "/repo/b", defaultBaseBranch: "main" } as Project,
];
function task(projectId: string, seq: number, extra: Partial<Task> = {}): Task {
	return {
		id: `${projectId.slice(0, 8)}-task-${seq}`, seq, projectId, title: `Task ${seq}`, description: "", status: "todo",
		baseBranch: "main", groupId: null, variantIndex: null, agentId: null, configId: null,
		createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra,
	} as Task;
}
const TASKS: Record<string, Task[]> = { [PROJECT_A]: [task(PROJECT_A, 1), task(PROJECT_A, 2, { status: "in-progress" })], [PROJECT_B]: [task(PROJECT_B, 1)] };

let calls: CliRequest[];
let signals: Array<AbortSignal | undefined>;
let storePath: string;
let dir: string;

async function handle(req: CliRequest, signal?: AbortSignal): Promise<CliResponse> {
	calls.push(req);
	signals.push(signal);
	const p = req.params ?? {};
	const data = (() => {
		switch (req.method) {
			case "projects.list": return PROJECTS;
			case "spaces.list": return { spaces: [], order: [] };
			case "tasks.list": return TASKS[String(p.projectId)] ?? [];
			case "ui.state": return { appRunning: true, foreground: true, activeProjectId: PROJECT_B, activeTaskId: "x", userIdleSeconds: 3, tmux: { secret: 1 } };
			case "sender.wait": return { items: [], cursor: null, more: false };
			case "approvals.list": return { requests: [{ projectId: PROJECT_A, taskId: "t" }, { projectId: PROJECT_B, taskId: "u" }] };
			default: return {};
		}
	})();
	return { id: req.id, ok: true, data };
}

function issue(overrides: Partial<McpTokenRecord> & { scopes?: McpScope[] } = {}): { token: string; record: McpTokenRecord } {
	const { token, id, sha256 } = generateMcpToken();
	const record: McpTokenRecord = {
		id, sha256, sender: "openclaw:home:main", scopes: ["read"], projects: [PROJECT_A], autoApprove: false, label: null,
		createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, ...overrides,
	};
	return { token, record };
}

function writeStore(records: McpTokenRecord[]): void {
	writeFileSync(storePath, JSON.stringify({ v: 1, enabled: true, listen: { port: 7391 }, tokens: records }));
}

function makeHandler() {
	return createMcpHandler({ handle, cache: new McpConfigCache(storePath) });
}

function post(token: string | null, body: unknown, headers: Record<string, string> = {}): Request {
	return new Request("http://127.0.0.1:7391/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function callTool(h: ReturnType<typeof makeHandler>, token: string, name: string, args: unknown = {}) {
	const res = await h.fetch(post(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), "127.0.0.1");
	const body = await res.json() as { result?: { structuredContent: { exitCode: number; json?: any; error?: { code: string; message: string } }; isError: boolean }; error?: { code: number; message: string } };
	return body;
}

beforeEach(() => {
	calls = [];
	signals = [];
	logged.length = 0;
	_resetAuthRateLimitForTests();
	dir = mkdtempSync(`${tmpdir()}/dev3-mcp-store-`);
	storePath = `${dir}/mcp.json`;
	writeFileSync(`${home}/external-senders.json`, JSON.stringify({ senders: { "openclaw:home:main": { label: "Main" } } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("HTTP gate", () => {
	it("answers only POST /mcp", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const h = makeHandler();
		expect((await h.fetch(new Request("http://127.0.0.1/", { method: "POST" }), "p")).status).toBe(404);
		expect((await h.fetch(new Request("http://127.0.0.1/mcp", { headers: { authorization: `Bearer ${token}` } }), "p")).status).toBe(405);
	});

	it("refuses any browser Origin before looking at the token", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const res = await makeHandler().fetch(post(token, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://evil.example" }), "p");
		expect(res.status).toBe(403);
		expect(calls).toEqual([]);
	});

	it("checks the bearer before reading the body", async () => {
		writeStore([issue().record]);
		// A body that never ends: reading it would hang the handler past the race.
		const body = new ReadableStream({ start() {} });
		const req = new Request("http://127.0.0.1/mcp", { method: "POST", body, duplex: "half" } as RequestInit);
		const hung = new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500));
		const res = await Promise.race([makeHandler().fetch(req, "p"), hung]);
		expect(res === "hung" ? res : (res as Response).status).toBe(401);
	});

	it("refuses unknown, revoked and expired tokens, and a token whose sender was unregistered", async () => {
		const revoked = issue({ revokedAt: new Date().toISOString() });
		const expired = issue({ expiresAt: new Date(Date.now() - 1).toISOString() });
		const orphan = issue({ sender: "gone" });
		writeStore([revoked.record, expired.record, orphan.record]);
		const h = makeHandler();
		for (const t of ["dev3mcp_unknown", revoked.token, expired.token, orphan.token]) {
			expect((await h.fetch(post(t, { jsonrpc: "2.0", id: 1, method: "ping" }), `peer-${t}`)).status).toBe(401);
		}
		expect((await h.fetch(post(null, { jsonrpc: "2.0", id: 1, method: "ping" }), "x")).status).toBe(401);
	});

	it("throttles failures per peer but never a valid token from the same peer", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const h = makeHandler();
		for (let i = 0; i < 5; i++) expect((await h.fetch(post("dev3mcp_bad", {}), "127.0.0.1")).status).toBe(401);
		const throttled = await h.fetch(post("dev3mcp_bad", {}), "127.0.0.1");
		expect(throttled.status).toBe(429);
		expect(throttled.headers.get("retry-after")).toBeTruthy();
		expect((await h.fetch(post(token, { jsonrpc: "2.0", id: 1, method: "ping" }), "127.0.0.1")).status).toBe(200);
	});

	it("never puts the token or the Authorization header in a log line", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const h = makeHandler();
		await h.fetch(post(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks_list", arguments: { project: PROJECT_A } } }), "p");
		await h.fetch(post(`${token}x`, {}), "p");
		const text = JSON.stringify(logged);
		expect(logged.length).toBeGreaterThan(0);
		expect(text).not.toContain("dev3mcp_");
		expect(text.toLowerCase()).not.toContain("authorization");
		expect(text).not.toContain(record.sha256);
	});
});

describe("JSON-RPC", () => {
	it("speaks initialize, ping, tools/list; 202 for notifications; refuses batches", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const h = makeHandler();
		const init = await (await h.fetch(post(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), "p")).json() as any;
		expect(init.result.protocolVersion).toBe("2025-06-18");
		expect((await h.fetch(post(token, { jsonrpc: "2.0", method: "notifications/initialized" }), "p")).status).toBe(202);
		const batch = await h.fetch(post(token, [{ jsonrpc: "2.0", id: 1, method: "ping" }]), "p");
		expect(batch.status).toBe(400);
		expect(((await batch.json()) as any).error.code).toBe(-32600);
		expect(((await (await h.fetch(post(token, "{oops"), "p")).json()) as any).error.code).toBe(-32700);
		const list = await (await h.fetch(post(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }), "p")).json() as any;
		const names = list.result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain("tasks_list");
		expect(names).not.toContain("stats_get");
		expect(((await callTool(h, token, "no_such_tool")).error)?.code).toBe(-32602);
	});
});

describe("scopes and the project allow-list", () => {
	it("refuses a tool outside the token's scopes", async () => {
		const { token, record } = issue({ scopes: ["read"] });
		writeStore([record]);
		const out = await callTool(makeHandler(), token, "stats_get", { kind: "limits" });
		expect(out.result?.structuredContent.error?.code).toBe("SCOPE_DENIED");
		expect(out.result?.isError).toBe(true);
		expect(calls.some((c) => c.method.startsWith("stats."))).toBe(false);
	});

	it("refuses a project outside the allow-list before calling its handler", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const out = await callTool(makeHandler(), token, "tasks_list", { project: PROJECT_B });
		expect(out.result?.structuredContent.error?.code).toBe("SCOPE_DENIED");
		expect(calls.filter((c) => c.method === "tasks.list")).toEqual([]);
	});

	it("never finds a task in a project outside the allow-list", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const out = await callTool(makeHandler(), token, "task_show", { task: TASKS[PROJECT_B][0].id });
		expect(out.result?.structuredContent.exitCode).toBe(1);
		expect(calls.some((c) => c.method === "task.show")).toBe(false);
	});

	it("filters lists and nulls focus outside the allow-list", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const h = makeHandler();
		const projects = (await callTool(h, token, "projects_list")).result?.structuredContent.json;
		expect(projects.map((p: { id: string }) => p.id)).toEqual([PROJECT_A]);
		const approvals = (await callTool(h, token, "approvals_list")).result?.structuredContent.json;
		expect(approvals.requests.map((r: { projectId: string }) => r.projectId)).toEqual([PROJECT_A]);
		const ui = (await callTool(h, token, "ui_state")).result?.structuredContent.json;
		expect(ui).toEqual({ appRunning: true, foreground: true, activeProjectId: null, activeTaskId: null, userIdleSeconds: 3 });
	});

	it("rejects arguments a tool does not declare, so no sender or lease field can be smuggled in", async () => {
		const { token, record } = issue();
		writeStore([record]);
		const h = makeHandler();
		for (const extra of ["asSender", "sourceTaskId", "takeOver", "projectId"]) {
			const out = await callTool(h, token, "tasks_list", { project: PROJECT_A, [extra]: "x" });
			expect(out.result?.structuredContent.exitCode).toBe(3);
			expect(out.result?.structuredContent.error?.code).toBe("USAGE");
		}
	});
});

describe("contracts", () => {
	it("every tool's schema is closed", () => {
		for (const tool of MCP_TOOLS) expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
	});

	it("every success code a tool declares is a documented CLI exit code", () => {
		const documented = new Set<number>(CLI_EXIT_CODE_DEFINITIONS.map((d) => d.code));
		for (const tool of MCP_TOOLS) for (const code of tool.successCodes) expect(documented.has(code), tool.name).toBe(true);
	});

	it("never declares free text as a trusted field", () => {
		const FREE_TEXT = /(^|\.|\[\])(title|taskTitle|description|overview|content|name|label|subject|body|text|snippets|message|path|branch|baseBranch|prUrl|url|replyCommand|requesterTitle|projectName|fromTitle|detail)(\[\])?$/;
		for (const tool of MCP_TOOLS) for (const field of tool.trustedFields) expect(FREE_TEXT.test(field), `${tool.name}: ${field}`).toBe(false);
	});
});

describe("disconnects", () => {
	it("abort a read-only park (inbox_wait) and nothing else", async () => {
		const { token, record } = issue({ scopes: ["read", "send"] });
		writeStore([record]);
		const h = makeHandler();
		await callTool(h, token, "inbox_wait", { clientId: "gw" });
		expect(signals[calls.findIndex((c) => c.method === "sender.wait")]).toBeInstanceOf(AbortSignal);
		await callTool(h, token, "tasks_list", { project: PROJECT_A });
		expect(signals[calls.findIndex((c) => c.method === "tasks.list")]).toBeUndefined();
	});
});
