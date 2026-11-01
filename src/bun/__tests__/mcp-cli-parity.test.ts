import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../cli/socket-client", () => ({ sendRequest: vi.fn() }));

import type { CliResponse, Project, Task } from "../../shared/types";
import { sendRequest } from "../../cli/socket-client";
import { handleTasks } from "../../cli/commands/tasks";
import { handleProjects } from "../../cli/commands/projects";
import { handleApprovals, handleStats } from "../../cli/commands/stats";
import { handleTask } from "../../cli/commands/task";
import { findTool, runTool, type ToolContext } from "../mcp/tools";
import type { McpTokenRecord } from "../mcp/token-store";

const PROJECT: Project = { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "A", path: "/repo/a", defaultBaseBranch: "main" } as Project;
const TASKS: Task[] = [1, 2, 3].map((seq) => ({
	id: `aaaaaaaa-task-0000-0000-00000000000${seq}`, seq, projectId: PROJECT.id, title: `T${seq}`, description: "d",
	status: seq === 2 ? "in-progress" : "todo", priority: seq === 3 ? "P1" : undefined, baseBranch: "main", groupId: null,
	variantIndex: null, agentId: null, configId: null, worktreePath: "/wt", createdAt: "2026-10-01T00:00:00Z", updatedAt: `2026-10-0${seq}T00:00:00Z`,
} as Task));
const DATA: Record<string, unknown> = {
	"projects.list": [PROJECT],
	"spaces.list": { spaces: [], order: [] },
	"tasks.list": TASKS,
	"task.show": TASKS[1],
	"approvals.list": { requests: [{ kind: "launch", projectId: PROJECT.id, taskId: TASKS[0].id, createdAt: 1 }] },
	"stats.prices": { fetchedAt: null, models: [{ model: "m", rate: { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 } }] },
};
const answer = async (method: string): Promise<CliResponse> => ({ id: "x", ok: true, data: DATA[method] });

const TOKEN: McpTokenRecord = {
	id: "t", sha256: "0".repeat(64), sender: "s", scopes: ["read", "stats"], projects: [PROJECT.id], autoApprove: false,
	label: null, createdAt: "", expiresAt: null, revokedAt: null,
};
const ctx: ToolContext = { token: TOKEN, senderLabel: "S", call: (method) => answer(method) };

let stdout = "";
beforeEach(() => {
	stdout = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	vi.mocked(sendRequest).mockImplementation((_s, method) => answer(method));
});
afterEach(() => vi.restoreAllMocks());

async function tool(name: string, args: Record<string, unknown>) {
	const out = await runTool(findTool(name)!, args, ctx);
	expect(out.exitCode).toBe(0);
	return out.json;
}

describe("MCP json is the CLI --json", () => {
	it("tasks_list", async () => {
		await handleTasks("list", { positional: [], flags: { project: PROJECT.id, json: "true", limit: "2", sort: "seq" } }, "/s", null);
		expect(await tool("tasks_list", { project: PROJECT.id, limit: 2, sort: "seq" })).toEqual(JSON.parse(stdout));
	});

	it("projects_list", async () => {
		await handleProjects("list", { positional: [], flags: { json: "true" } }, "/s");
		expect(await tool("projects_list", {})).toEqual(JSON.parse(stdout));
	});

	it("approvals_list", async () => {
		await handleApprovals("list", { positional: [], flags: { json: "true" } }, "/s", null);
		expect(await tool("approvals_list", {})).toEqual(JSON.parse(stdout));
	});

	it("stats_prices", async () => {
		await handleStats("prices", { positional: [], flags: { json: "true", model: "m" } }, "/s", null);
		expect(await tool("stats_prices", { models: ["m"] })).toEqual(JSON.parse(stdout));
	});

	it("task_show, minus the worktree path", async () => {
		await handleTask("show", { positional: [TASKS[1].id], flags: { json: "true" } }, "/s", null);
		const { worktree, ...cli } = JSON.parse(stdout);
		expect(worktree).toBe("/wt");
		expect(await tool("task_show", { task: TASKS[1].id })).toEqual(cli);
	});
});
