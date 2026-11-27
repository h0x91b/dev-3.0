import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { handleAgent } from "../commands/agent";
import { encodeAgentHandle } from "../../shared/agent-handle";
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
	it("rejects invalid flags (incl. any --account) and a missing task before sending", async () => {
		const cases: Array<[Record<string, string>, CliContext | null]> = [
			[{ config: "wrong" }, context], [{ prompt: " " }, context], [{ yes: "true" }, context],
			[{ agent: "builtin-codex", config: "codex-default", account: "slot" }, context],
			[{ agent: "builtin-codex", config: "codex-default", account: "system" }, context],
			[{}, null],
		];
		for (const [flags, ctx] of cases) {
			await expect(spawn(flags, ctx), JSON.stringify(flags)).rejects.toThrow("EXIT_3");
		}
		expect(sendRequest).not.toHaveBeenCalled();
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
describe("agent exit", () => {
	const HANDLE = encodeAgentHandle({ paneId: "%2", sessionId: null, paneToken: "token", agentProcess: "77@Mon Jan 1 00:00:00 2024" });
	const scheduled = { outcome: "scheduled", taskId: context.taskId, seq: 4, paneId: "%2", agent: "Codex / High", self: true, already: false };
	const respond = (data: unknown) => vi.mocked(sendRequest).mockImplementation(async (_socket, method) => ({ id: "1", ok: true, data: method === "approval.policy" ? { autoApproveMs: 0 } : data }));
	const exit = (flags: Record<string, string> = {}, ctx: CliContext | null = context) => handleAgent("exit", { flags, positional: [] }, "/tmp/agent.sock", ctx);
	let stderr = "";
	beforeEach(() => {
		stderr = "";
		vi.mocked(process.stderr.write).mockImplementation((s) => { stderr += s; return true; });
		vi.stubEnv("TMUX_PANE", "%2");
		vi.stubEnv("DEV3_PANE_ID", "");
		respond(scheduled);
	});
	afterEach(() => vi.unstubAllEnvs());

	it("asks for the calling pane's exit, attributed to its task, and tells the agent to end its turn", async () => {
		await exit();
		expect(sendRequest).toHaveBeenLastCalledWith("/tmp/agent.sock", "agent.exit", { taskId: context.taskId, projectId: context.projectId, sourceTaskId: context.taskId, selfPaneId: "%2" }, { timeoutMs: 600000 });
		expect(output).toBe("Exit scheduled for pane %2 (Codex / High). It closes after its current turn ends. End your turn now.\n");
	});
	it("takes a native pane id from DEV3_PANE_ID before TMUX_PANE", async () => {
		vi.stubEnv("DEV3_PANE_ID", "pane-4");
		await exit();
		expect(sendRequest).toHaveBeenLastCalledWith(expect.anything(), "agent.exit", expect.objectContaining({ selfPaneId: "pane-4" }), expect.anything());
	});
	it("closes another agent by handle, with a task, a project and a reason, without telling it to end its turn", async () => {
		respond({ ...scheduled, self: false });
		await exit({ agent: HANDLE, task: "seq:8", project: "project-2", reason: "Review done" });
		expect(sendRequest).toHaveBeenLastCalledWith(expect.anything(), "agent.exit", {
			taskId: "seq:8", projectId: "project-2", sourceTaskId: context.taskId, selfPaneId: "%2", agentHandle: HANDLE, reason: "Review done",
		}, expect.anything());
		expect(output).toBe("Exit scheduled for pane %2 (Codex / High). It closes after its current turn ends.\n");
	});
	it("says so when the exit was already scheduled, and prints the outcome as JSON", async () => {
		respond({ ...scheduled, already: true });
		await exit();
		expect(output).toBe("Exit already scheduled for pane %2.\n");
		output = "";
		await exit({ json: "true" });
		expect(JSON.parse(output)).toEqual({ ...scheduled, already: true });
	});
	it("maps a decline to the launch-declined exit code and a timeout to a non-blind-retry message", async () => {
		respond({ outcome: "declined", taskId: context.taskId, seq: 4 });
		await expect(exit()).rejects.toThrow("EXIT_10");
		expect(stderr).toContain("User declined closing the agent");
		stderr = "";
		vi.mocked(sendRequest).mockImplementation(async (_socket, method) => {
			if (method === "approval.policy") return { id: "1", ok: true, data: { autoApproveMs: 0 } };
			throw new Error("Socket timeout after 600000ms");
		});
		await expect(exit()).rejects.toThrow("EXIT_1");
		expect(stderr).toContain("Timed out waiting for the exit request");
	});
	it("maps the main agent to its own exit code and everything else that is not an extra agent to another", async () => {
		respond({ outcome: "refused", reason: "main-agent", message: "This is the task's main agent; dev3 agent exit only closes extra agents. To finish the task, request completion: dev3 task move --status completed" });
		await expect(exit()).rejects.toThrow("EXIT_51");
		expect(stderr).toContain("dev3 task move --status completed");
		respond({ outcome: "refused", reason: "not-extra", message: "Pane %9 is not an agent pane." });
		await expect(exit()).rejects.toThrow("EXIT_52");
	});
	it("refuses with the not-extra code, asking nothing, when the shell has no pane id and no handle is given", async () => {
		vi.stubEnv("TMUX_PANE", "");
		await expect(exit()).rejects.toThrow("EXIT_52");
		expect(stderr).toContain("no pane id");
		expect(sendRequest).not.toHaveBeenCalled();
	});
	it("rejects bad arguments before sending anything", async () => {
		const cases: Array<[Record<string, string>, CliContext | null]> = [
			[{ agent: "true" }, context], [{ agent: "not-a-handle!" }, context], [{ yes: "true" }, context], [{ reason: "" }, context], [{}, null],
		];
		for (const [flags, ctx] of cases) {
			await expect(exit(flags, ctx), JSON.stringify(flags)).rejects.toThrow("EXIT_3");
		}
		await expect(handleAgent("exit", { flags: {}, positional: ["extra"] }, "/tmp/agent.sock", context)).rejects.toThrow("EXIT_3");
		expect(sendRequest).not.toHaveBeenCalled();
	});
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
		expect(output).toContain("Resumed task <seq:8> on tmux (tmux session dev3-task-8)");
		expect(output).toContain("conversation s1 (exact)  pane %3");
		expect(output).toContain("failed: split failed");
	});
	it("passes --allow-agent-latest and runs without a requester outside a worktree", async () => {
		respond(resumed);
		await resume({ task: "seq:8", "allow-agent-latest": "true" }, null);
		expect(sendRequest).toHaveBeenLastCalledWith(expect.anything(), "agent.resume", { taskId: "seq:8", allowAgentLatest: true }, expect.anything());
	});
	it("asks as an external sender on agent.resumeAsSender, never on plain agent.resume", async () => {
		respond(resumed);
		await resume({ task: "seq:8", project: "project-1", "as-sender": "openclaw:home:main" }, null);
		expect(sendRequest).toHaveBeenLastCalledWith(expect.anything(), "agent.resumeAsSender", expect.objectContaining({ asSender: "openclaw:home:main" }), expect.anything());
	});
	it("prints the whole outcome as JSON", async () => {
		respond(resumed);
		await resume({ task: "seq:8", json: "true" });
		expect(JSON.parse(output)).toEqual(resumed);
	});
	it("maps each non-resumed outcome to its documented exit code, still printing JSON", async () => {
		for (const [data, exit] of [
		[{ outcome: "already-running", taskId: "task-8", seq: 8, backend: "tmux" }, "EXIT_31"],
		[{ outcome: "unavailable", taskId: "task-8", seq: 8, reason: "no-saved-session", message: "nothing saved" }, "EXIT_32"],
		[{ outcome: "unavailable", taskId: "task-8", seq: 8, reason: "session-id-unknown", message: "no id", panes: [] }, "EXIT_32"],
		[{ outcome: "declined", taskId: "task-8", seq: 8 }, "EXIT_10"],
		[{ outcome: "declined", taskId: "task-8", seq: 8, stale: true }, "EXIT_10"],
		] as const) {
			output = "";
			respond(data);
			await expect(resume({ task: "seq:8", json: "true" }), JSON.stringify(data)).rejects.toThrow(exit);
			expect(JSON.parse(output)).toEqual(data);
		}
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
	it("refuses launch flags (a resume restores what was saved), an empty --account and a missing task", async () => {
		const cases: Array<[Record<string, string>, CliContext | null]> = [
			[{ task: "seq:8", agent: "builtin-codex" }, context], [{ task: "seq:8", config: "x" }, context],
			[{ task: "seq:8", prompt: "go" }, context], [{ task: "seq:8", fresh: "true" }, context],
			[{ task: "seq:8", account: "" }, context], [{ task: "seq:8", account: "true" }, context],
			[{}, null],
		];
		for (const [flags, ctx] of cases) {
			await expect(resume(flags, ctx), JSON.stringify(flags)).rejects.toThrow("EXIT_3");
		}
		expect(sendRequest).not.toHaveBeenCalled();
	});
	it("sends --account as the resume account, with system meaning null", async () => {
		respond(resumed);
		for (const [flag, accountId] of [["acct-2", "acct-2"], ["system", null]] as const) {
			await resume({ task: "seq:8", account: flag }, null);
			expect(sendRequest, flag).toHaveBeenLastCalledWith(expect.anything(), "agent.resume", { taskId: "seq:8", allowAgentLatest: false, accountId }, expect.anything());
		}
	});
});
