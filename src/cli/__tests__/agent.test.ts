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
