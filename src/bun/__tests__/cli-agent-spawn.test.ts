import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";
vi.mock("../agents", async (importOriginal) => ({
	...(await importOriginal<typeof import("../agents")>()),
	getAllAgents: vi.fn(),
}));
vi.mock("../settings", () => ({ loadSettings: vi.fn(async () => ({ defaultAgentId: "agent-1", defaultConfigId: "config-1", agentLaunchAutoApproveMinutes: 0 })), loadSettingsSync: vi.fn(() => ({})) }));
vi.mock("../data", () => ({ getTask: vi.fn() }));
vi.mock("../agent-accounts", () => ({ listAgentAccounts: vi.fn(async () => ({ codex: { accounts: [{ id: "slot-1" }] } })) }));
vi.mock("../rpc-handlers/settings-config", () => ({ settingsConfigHandlers: { checkAgentAvailability: vi.fn(async () => [{ agentId: "agent-1", installed: true }]) } }));
vi.mock("../rpc-handlers/tmux-pty", () => ({ tmuxPtyHandlers: { spawnAgentInTask: vi.fn() } }));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: vi.fn() }));
import { listCliAgents, spawnCliAgent, validateLaunchSuggestion } from "../cli-agent-spawn";
import { getAllAgents } from "../agents";
import { getTask } from "../data";
import { tmuxPtyHandlers } from "../rpc-handlers/tmux-pty";
import { settingsConfigHandlers } from "../rpc-handlers/settings-config";
import { getPushMessage } from "../rpc-handlers/shared-pure";
import { listAgentAccounts } from "../agent-accounts";
import { _resetAgentRequestsForTests, createAgentRequest, resolveAgentRequest, voidAgentRequest, pendingAgentLaunchDialogs } from "../agent-requests";
const project = { id: "project-1", name: "Fixture", path: "/repo" } as Project;
const task = { id: "task-1", projectId: project.id, seq: 1, title: "Fixture task", status: "in-progress", worktreePath: "/repo/wt", lifecycleStartedAt: "start-1" } as Task;
const push = vi.fn();
const options = (requester: Task | null = task) => ({ project, task, requester, choice: { agentId: "agent-1", configId: "config-1" }, handoff: false, prompt: "Review only" });
beforeEach(() => {
	vi.clearAllMocks(); _resetAgentRequestsForTests();
	vi.mocked(getAllAgents).mockResolvedValue([{ id: "agent-1", baseCommand: "codex", name: "Fixture", configurations: [{ id: "config-1" }], defaultConfigId: "config-1" }] as any);
	vi.mocked(getTask).mockResolvedValue(task);
	vi.mocked(getPushMessage).mockReturnValue(push);
	vi.mocked(settingsConfigHandlers.checkAgentAvailability).mockResolvedValue([{ agentId: "agent-1", installed: true }] as any);
	vi.mocked(tmuxPtyHandlers.spawnAgentInTask).mockResolvedValue({ paneId: "%9", backend: "tmux", agentId: "agent-1", configId: "config-1", handoff: null });
});
afterEach(() => _resetAgentRequestsForTests());
async function answer(approved: boolean, launch?: any) {
	await vi.waitFor(() => expect(push).toHaveBeenCalledWith("agentLaunchRequested", expect.anything()));
	resolveAgentRequest(push.mock.calls[0][1].requestId, { approved, launch });
}
describe("managed CLI agent spawning", () => {
	it("uses the global preset and default account rather than the target task's account", async () => {
		const pending = spawnCliAgent({ ...options(), task: { ...task, accountId: "task-account" }, choice: { agentId: null, configId: null } });
		await answer(true);
		await pending;
		expect(tmuxPtyHandlers.spawnAgentInTask).toHaveBeenCalledWith({
			taskId: task.id, projectId: project.id, agentId: "agent-1", configId: "config-1", prompt: "Review only", handoff: false,
		});
	});
	it("keeps the requested non-default model/effort preset with no account override", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([{
			id: "agent-1", baseCommand: "codex", configurations: [
				{ id: "config-1" }, { id: "config-2", model: "gpt-6.1", effort: "high" },
			], defaultConfigId: "config-1",
		}] as any);
		const pending = spawnCliAgent({ ...options(), choice: { agentId: "agent-1", configId: "config-2" } });
		await answer(true);
		await pending;
		expect(tmuxPtyHandlers.spawnAgentInTask).toHaveBeenCalledWith({
			taskId: task.id, projectId: project.id, agentId: "agent-1", configId: "config-2", prompt: "Review only", handoff: false,
		});
	});
	it("does not carry an extra caller-supplied account field into approval or launch", async () => {
		const choice = { agentId: "agent-1", configId: "config-1", accountId: "slot-1" };
		const pending = spawnCliAgent({ ...options(), choice });
		await answer(true);
		await pending;
		expect(push.mock.calls[0][1].spawn.choice).not.toHaveProperty("accountId");
		expect(vi.mocked(tmuxPtyHandlers.spawnAgentInTask).mock.calls[0][0]).not.toHaveProperty("accountId");
	});
	it("asks even when adding an agent to the requesting task itself", async () => {
		const pending = spawnCliAgent(options());
		await answer(false); await pending;
		expect(push.mock.calls[0][1]).toMatchObject({ canAddVariants: false, requesterSeq: 1, spawn: { choice: { agentId: "agent-1" }, prompt: "Review only" } });
	});
	it("retains the extra-agent approval for a reconnecting browser", async () => {
		const pending = spawnCliAgent(options());
		await vi.waitFor(() => expect(pendingAgentLaunchDialogs()).toHaveLength(1));
		expect(pendingAgentLaunchDialogs()[0]).toMatchObject({ spawn: { prompt: "Review only" } });
		await answer(false); await pending;
		expect(pendingAgentLaunchDialogs()).toEqual([]);
	});
	it("starts no pane when declined", async () => {
		const pending = spawnCliAgent(options()); await answer(false);
		expect(await pending).toEqual({ approved: false });
		expect(tmuxPtyHandlers.spawnAgentInTask).not.toHaveBeenCalled();
	});
	it.each(["slot-1", null])("uses the user's selected account %j and returns the pane identity", async (accountId) => {
		const pending = spawnCliAgent(options());
		await answer(true, { variants: [{ agentId: "agent-1", configId: "config-1", accountId }] });
		expect(await pending).toMatchObject({ approved: true, spawn: { paneId: "%9" } });
		expect(tmuxPtyHandlers.spawnAgentInTask).toHaveBeenCalledWith(expect.objectContaining({ accountId, prompt: "Review only" }));
	});
	it("validates the account against the preset's effective harness", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([{ id: "agent-1", baseCommand: "claude", configurations: [{ id: "config-1", baseCommandOverride: "codex" }] }] as any);
		vi.mocked(listAgentAccounts).mockResolvedValue({
			claude: { accounts: [{ id: "claude-slot" }] },
			codex: { accounts: [{ id: "slot-1" }] },
		} as any);
		const pending = spawnCliAgent(options());
		await answer(true, { variants: [{ agentId: "agent-1", configId: "config-1", accountId: "slot-1" }] });
		await pending;
		expect(tmuxPtyHandlers.spawnAgentInTask).toHaveBeenCalledWith(expect.objectContaining({ accountId: "slot-1" }));
	});
	it("rejects an account belonging only to the overridden harness", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([{ id: "agent-1", baseCommand: "claude", configurations: [{ id: "config-1", baseCommandOverride: "codex" }] }] as any);
		vi.mocked(listAgentAccounts).mockResolvedValue({
			claude: { accounts: [{ id: "claude-slot" }] },
			codex: { accounts: [{ id: "slot-1" }] },
		} as any);
		const pending = spawnCliAgent(options());
		const assertion = expect(pending).rejects.toThrow("Unknown codex account");
		await answer(true, { variants: [{ agentId: "agent-1", configId: "config-1", accountId: "claude-slot" }] });
		await assertion;
		expect(tmuxPtyHandlers.spawnAgentInTask).not.toHaveBeenCalled();
	});
	it("does not reuse a task-start approval for an extra pane", async () => {
		const activation = createAgentRequest("launch", task.id, project.id);
		const outcome = spawnCliAgent(options()).catch((error: unknown) => error);
		await vi.waitFor(() => expect(settingsConfigHandlers.checkAgentAvailability).toHaveBeenCalled());
		resolveAgentRequest(activation.requestId, { approved: true });
		expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringContaining("Another launch approval") }));
		expect(tmuxPtyHandlers.spawnAgentInTask).not.toHaveBeenCalled();
	});
	it("joins retries without opening two panes for one approval", async () => {
		const first = spawnCliAgent(options()); const second = spawnCliAgent(options());
		await answer(true); await Promise.all([first, second]);
		expect(tmuxPtyHandlers.spawnAgentInTask).toHaveBeenCalledTimes(1);
	});
	it("rejects a different simultaneous spawn", async () => {
		const pending = spawnCliAgent(options());
		await expect(spawnCliAgent({ ...options(), prompt: "Different" })).rejects.toThrow("Another agent spawn");
		await answer(false); await pending;
	});
	it("releases a stale spawn so the next run can request a different agent prompt", async () => {
		const pending = spawnCliAgent(options());
		await vi.waitFor(() => expect(pendingAgentLaunchDialogs()).toHaveLength(1));
		voidAgentRequest("launch", task.id);
		expect(await pending).toEqual({ approved: false, stale: true });
		expect(pendingAgentLaunchDialogs()).toEqual([]);
		push.mockClear();
		const next = spawnCliAgent({ ...options(), prompt: "New run review" });
		await answer(false);
		expect(await next).toEqual({ approved: false });
		expect(tmuxPtyHandlers.spawnAgentInTask).not.toHaveBeenCalled();
	});
	it("does not turn a reset task into a launch on an unapproved new run", async () => {
		const pending = spawnCliAgent(options());
		vi.mocked(getTask).mockResolvedValue({ ...task, lifecycleStartedAt: "start-2" });
		const assertion = expect(pending).rejects.toThrow("run changed"); await answer(true); await assertion;
		expect(tmuxPtyHandlers.spawnAgentInTask).not.toHaveBeenCalled();
	});
	it.each([{ status: "todo" }, { hibernated: true }, { draft: true }, { worktreePath: null }])("rejects inactive target %j before approval", async (change) => {
		await expect(spawnCliAgent({ ...options(), task: { ...task, ...change } as Task })).rejects.toThrow("running terminal");
		expect(push).not.toHaveBeenCalled();
	});
	it.each([{ agentId: "unknown", configId: null }, { agentId: "agent-1", configId: "unknown" }])("rejects unknown selection %j", async (choice) => {
		await expect(spawnCliAgent({ ...options(), choice })).rejects.toThrow("Unknown");
	});
	it("rejects an uninstalled agent before opening approval", async () => {
		vi.mocked(settingsConfigHandlers.checkAgentAvailability).mockResolvedValue([{ agentId: "agent-1", installed: false }] as any);
		await expect(spawnCliAgent(options())).rejects.toThrow("not installed");
		expect(push).not.toHaveBeenCalled();
	});
	it("runs a human CLI launch directly and preserves the native result", async () => {
		vi.mocked(tmuxPtyHandlers.spawnAgentInTask).mockResolvedValue({ paneId: "native-9", backend: "native", agentId: "agent-1", configId: "config-1", handoff: null });
		expect(await spawnCliAgent(options(null))).toMatchObject({ spawn: { backend: "native" } });
		expect(push).not.toHaveBeenCalled();
	});
});
describe("validateLaunchSuggestion", () => {
	beforeEach(() => {
		vi.mocked(getAllAgents).mockResolvedValue([
			{ id: "agent-1", baseCommand: "codex", configurations: [{ id: "config-1" }, { id: "config-cheap" }], defaultConfigId: "config-1" },
			{ id: "agent-2", baseCommand: "claude", configurations: [{ id: "config-2" }], defaultConfigId: "config-2" },
		] as any);
	});
	it("keeps the suggested agent and preset, with no account", async () => {
		expect(await validateLaunchSuggestion({ agentId: "agent-1", configId: "config-cheap" })).toEqual({ agentId: "agent-1", configId: "config-cheap" });
	});
	it("fills the agent's own default preset, not the global one, when --config is omitted", async () => {
		vi.mocked(settingsConfigHandlers.checkAgentAvailability).mockResolvedValue([{ agentId: "agent-2", installed: true }] as any);
		expect(await validateLaunchSuggestion({ agentId: "agent-2", configId: null })).toEqual({ agentId: "agent-2", configId: "config-2" });
	});
	it.each([
		[{ agentId: "nope", configId: null }, "Unknown agent"],
		[{ agentId: "agent-1", configId: "config-2" }, "Unknown config"],
		[{ agentId: null, configId: "config-1" }, "--config requires --agent"],
	])("rejects %j instead of falling back to a default", async (choice, message) => {
		await expect(validateLaunchSuggestion(choice)).rejects.toThrow(message);
	});
	it("rejects an agent that is not installed", async () => {
		vi.mocked(settingsConfigHandlers.checkAgentAvailability).mockResolvedValue([{ agentId: "agent-1", installed: false }] as any);
		await expect(validateLaunchSuggestion({ agentId: "agent-1", configId: null })).rejects.toThrow("not installed");
	});
});
describe("listCliAgents", () => {
	it("returns IDs and preset labels without preset env or command overrides", async () => {
		vi.mocked(getAllAgents).mockResolvedValue([{
			id: "agent-1", name: "Fixture", baseCommand: "codex",
			configurations: [{ id: "config-1", name: "High", model: "gpt", effort: "high", envVars: { OPENAI_API_KEY: "sk-secret" }, baseCommandOverride: "codex --x" }],
		}] as any);
		const listed = await listCliAgents();
		expect(listed).toEqual([{ id: "agent-1", name: "Fixture", configurations: [{ id: "config-1", name: "High", model: "gpt", effort: "high" }] }]);
		expect(JSON.stringify(listed)).not.toContain("sk-secret");
	});
});
