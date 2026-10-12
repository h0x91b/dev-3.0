import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { handleAgent } from "../commands/agent";
import { sendRequest } from "../socket-client";
import type { CliContext } from "../context";
vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
vi.mock("../stdin", () => ({ readStdin: vi.fn(async () => "instructions from stdin") }));
const context: CliContext = { projectId: "project-1", taskId: "aaaaaaaa-1111-2222-3333-444444444444", socketPath: "/tmp/agent.sock" };
let output = "";
beforeEach(() => {
	vi.clearAllMocks(); output = "";
	vi.spyOn(process.stdout, "write").mockImplementation((s) => { output += s; return true; });
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`EXIT_${code}`); });
	vi.mocked(sendRequest).mockImplementation(async (_socket, method) => ({ id: "1", ok: true, data: method === "approval.policy" ? { autoApproveMs: 0 } : { approved: true, spawn: { paneId: "%9", backend: "tmux", agentId: "builtin-codex", configId: "codex-default", handoff: null } } }));
});
afterEach(() => vi.restoreAllMocks());
const spawn = (flags: Record<string, string> = {}, ctx: CliContext | null = context) => handleAgent("spawn", { flags, positional: [] }, "/tmp/agent.sock", ctx);
describe("agent spawn", () => {
	it("targets the current task and attributes the requester", async () => {
		await spawn();
		expect(sendRequest).toHaveBeenLastCalledWith("/tmp/agent.sock", "agent.spawn", { taskId: context.taskId, projectId: context.projectId, sourceTaskId: context.taskId, agentId: null, configId: null, handoff: false }, { timeoutMs: 600000 });
	});
	it("passes the selected model/effort preset, handoff and stdin prompt without an account override", async () => {
		await spawn({ task: "seq:8", agent: "builtin-codex", config: "codex-default", prompt: "-", handoff: "true" });
		expect(sendRequest).toHaveBeenLastCalledWith("/tmp/agent.sock", "agent.spawn", {
			taskId: "seq:8", projectId: context.projectId, sourceTaskId: context.taskId,
			agentId: "builtin-codex", configId: "codex-default", prompt: "instructions from stdin", handoff: true,
		}, { timeoutMs: 600000 });
	});
	it.each(["slot", "system"])("rejects --account %s even with a valid agent and preset", async (account) => {
		await expect(spawn({ agent: "builtin-codex", config: "codex-default", account })).rejects.toThrow("EXIT_3");
		expect(sendRequest).not.toHaveBeenCalled();
	});
	it("prints a machine-readable pane identity", async () => {
		await spawn({ json: "true" });
		expect(JSON.parse(output)).toMatchObject({ paneId: "%9", backend: "tmux" });
	});
	it("reports a launched agent whose pane id is unknown as a success", async () => {
		vi.mocked(sendRequest).mockImplementation(async (_socket, method) => ({ id: "1", ok: true, data: method === "approval.policy" ? { autoApproveMs: 0 } : { approved: true, spawn: { paneId: "", backend: "tmux", agentId: "builtin-codex", configId: null, handoff: null } } }));
		await spawn();
		expect(output).toContain("pane (id unknown)");
	});
	it("supports an explicit task outside a worktree without a requester", async () => {
		await spawn({ task: "seq:8", project: "project-2" }, null);
		expect(sendRequest).toHaveBeenLastCalledWith(expect.anything(), "agent.spawn", expect.not.objectContaining({ sourceTaskId: expect.anything() }), expect.anything());
	});
	it.each<Record<string, string>>([{ config: "wrong" }, { prompt: " " }, { yes: "true" }, { account: "slot" }])("rejects invalid flags %j before sending", async (flags) => {
		await expect(spawn(flags)).rejects.toThrow("EXIT_3");
		expect(sendRequest).not.toHaveBeenCalled();
	});
	it("requires a task", async () => {
		await expect(spawn({}, null)).rejects.toThrow("EXIT_3");
	});
	it("uses the existing launch-declined exit code", async () => {
		vi.mocked(sendRequest).mockResolvedValue({ id: "1", ok: true, data: { approved: false } });
		await expect(spawn()).rejects.toThrow("EXIT_10");
	});
	it("waits beyond a configured long auto-approval deadline", async () => {
		vi.mocked(sendRequest).mockResolvedValueOnce({ id: "1", ok: true, data: { autoApproveMs: 1200000 } });
		await spawn();
		expect(sendRequest).toHaveBeenLastCalledWith(expect.anything(), "agent.spawn", expect.anything(), { timeoutMs: 1320000 });
	});
});
it("lists agent and preset IDs", async () => {
	vi.mocked(sendRequest).mockResolvedValue({ id: "1", ok: true, data: [{ id: "agent-1", name: "Agent", configurations: [{ id: "preset-1", name: "Preset" }] }] });
	await handleAgent("list", { flags: {}, positional: [] }, "/tmp/agent.sock", context);
	expect(output).toContain("preset-1  Preset");
});
describe("agent resume", () => {
	const resumed = {
		outcome: "resumed",
		resume: {
			taskId: "task-8", seq: 8, projectId: "project-1", backend: "tmux", tmux: { socket: "dev3", session: "dev3-task-8" }, woke: false,
			panes: [
				{ index: 0, agentId: "builtin-claude", configId: "claude-default", accountId: null, agentFamily: "claude", storedSessionId: "s1", sessionId: "s1", mode: "exact", status: "resumed", paneId: "%3" },
				{ index: 1, agentId: "builtin-codex", configId: null, accountId: null, agentFamily: "codex", storedSessionId: "s2", sessionId: "s2", mode: "unverified", status: "failed", paneId: null, detail: "split failed" },
			],
		},
	};
	const respond = (data: unknown) => vi.mocked(sendRequest).mockImplementation(async (_socket, method) => ({ id: "1", ok: true, data: method === "approval.policy" ? { autoApproveMs: 0 } : data }));
	const resume = (flags: Record<string, string> = {}, ctx: CliContext | null = context) => handleAgent("resume", { flags, positional: [] }, "/tmp/agent.sock", ctx);

	it("asks for the managed resume of another task, attributed to the requester", async () => {
		respond(resumed);
		await resume({ task: "seq:8" });
		expect(sendRequest).toHaveBeenLastCalledWith("/tmp/agent.sock", "agent.resume", { taskId: "seq:8", projectId: context.projectId, sourceTaskId: context.taskId, allowAgentLatest: false }, { timeoutMs: 600000 });
		expect(output).toContain("Resumed task #8 on tmux (tmux session dev3-task-8)");
		expect(output).toContain("conversation s1 (exact)  pane %3");
		expect(output).toContain("failed: split failed");
	});
	it("passes --allow-agent-latest and runs without a requester outside a worktree", async () => {
		respond(resumed);
		await resume({ task: "seq:8", "allow-agent-latest": "true" }, null);
		expect(sendRequest).toHaveBeenLastCalledWith(expect.anything(), "agent.resume", { taskId: "seq:8", allowAgentLatest: true }, expect.anything());
	});
	it("prints the whole outcome as JSON", async () => {
		respond(resumed);
		await resume({ task: "seq:8", json: "true" });
		expect(JSON.parse(output)).toEqual(resumed);
	});
	it.each([
		[{ outcome: "already-running", taskId: "task-8", seq: 8, backend: "tmux" }, "EXIT_31"],
		[{ outcome: "unavailable", taskId: "task-8", seq: 8, reason: "no-saved-session", message: "nothing saved" }, "EXIT_32"],
		[{ outcome: "unavailable", taskId: "task-8", seq: 8, reason: "session-id-unknown", message: "no id", panes: [] }, "EXIT_32"],
		[{ outcome: "declined", taskId: "task-8", seq: 8 }, "EXIT_10"],
		[{ outcome: "declined", taskId: "task-8", seq: 8, stale: true }, "EXIT_10"],
	])("maps %j to its documented exit code, still printing JSON", async (data, exit) => {
		respond(data);
		await expect(resume({ task: "seq:8", json: "true" })).rejects.toThrow(exit);
		expect(JSON.parse(output)).toEqual(data);
	});
	it("names the pane that cannot resume instead of offering --allow-agent-latest", async () => {
		let stderr = "";
		vi.mocked(process.stderr.write).mockImplementation((s) => { stderr += s; return true; });
		respond({ outcome: "unavailable", taskId: "task-8", seq: 8, reason: "harness-cannot-resume", message: "would start over", panes: [
			{ index: 0, agentId: "custom", configId: null, accountId: null, agentFamily: null, storedSessionId: "x", sessionId: null, mode: "fresh", status: "skipped", paneId: null },
		] });
		await expect(resume({ task: "seq:8" })).rejects.toThrow("EXIT_32");
		expect(stderr).toContain("#0 main   custom  cannot resume — would start over  not resumed");
		expect(stderr).not.toContain("--allow-agent-latest");
	});
	it.each<Record<string, string>>([{ agent: "builtin-codex" }, { config: "x" }, { account: "slot" }, { prompt: "go" }, { fresh: "true" }])("refuses %j: a resume restores what was saved", async (flags) => {
		await expect(resume({ task: "seq:8", ...flags })).rejects.toThrow("EXIT_3");
		expect(sendRequest).not.toHaveBeenCalled();
	});
	it("requires a task", async () => {
		await expect(resume({}, null)).rejects.toThrow("EXIT_3");
	});
});
