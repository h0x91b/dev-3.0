import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskTitleHoverCard from "../TaskTitleHoverCard";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import type { CodingAgent, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getNativeTaskAgents: vi.fn().mockResolvedValue([]),
			getProjectClaudeLogin: vi.fn().mockResolvedValue({
				configDir: "/home/me/.claude-proj",
				identity: { email: "proj@example.com", organization: null, plan: null, planLabel: null, accountId: null },
			}),
			listAgentAccounts: vi.fn().mockResolvedValue({
				claude: {
					accounts: [{ id: "a1", kind: "claude", label: "Work", identity: { email: "work@example.com" }, auth: "api", api: null, createdAt: 0 }],
					activeId: null,
					systemConfigDir: "/home/me/.claude",
					systemIdentity: { email: "system@example.com", organization: null, plan: null, planLabel: null, accountId: null },
				},
				codex: { accounts: [], activeId: null, currentIdentity: null },
				omp: { accounts: [], activeId: null },
				pi: { accounts: [], activeId: null },
			}),
		},
	},
}));

const agents = [
	{ id: "builtin-claude", name: "Claude Code", baseCommand: "claude", configurations: [] },
	{ id: "builtin-codex", name: "Codex", baseCommand: "codex", configurations: [] },
	{ id: "pinned", name: "Pinned", baseCommand: "claude", defaultConfigId: "cfg", configurations: [{ id: "cfg", name: "Cfg", envVars: { CLAUDE_CONFIG_DIR: "/home/me/.claude-preset" } }] },
] as CodingAgent[];

function renderCard(task: Partial<Task>) {
	const full = { id: "t1", seq: 1, projectId: "p1", title: "Title", description: "", createdAt: "2025-01-01T00:00:00Z", agentId: null, ...task } as Task;
	return render(
		<I18nProvider>
			<TaskTitleHoverCard task={full} project={null} agents={agents}>
				<span>trigger</span>
			</TaskTitleHoverCard>
		</I18nProvider>,
	);
}

describe("TaskTitleHoverCard — agents row", () => {
	beforeEach(() => {
		vi.mocked(api.request.getProjectClaudeLogin).mockClear();
		vi.mocked(api.request.listAgentAccounts).mockClear();
	});
	afterEach(() => localStorage.removeItem("dev3-streamer-mode"));

	it("lists the agent's account after hover", async () => {
		renderCard({ agentId: "builtin-claude", accountId: "a1" });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect(await screen.findByText("Work")).toBeTruthy();
		expect(screen.getByText("Agents")).toBeTruthy();
		expect(screen.getByText("API")).toBeTruthy();
	});

	it("has no agents row for a task without an agent", async () => {
		renderCard({ agentId: null });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect(screen.getByTestId("task-title-hover-card")).toBeTruthy();
		expect(screen.queryByText("Agents")).toBeNull();
	});

	it("sets a tooltip with the email, but not in streamer mode", async () => {
		renderCard({ agentId: "builtin-claude", accountId: "a1" });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect((await screen.findByText("Work")).getAttribute("title")).toBe("Work");
		expect(screen.getByText("work@example.com").getAttribute("title")).toBe("work@example.com");
	});

	it("sets no tooltip in streamer mode", async () => {
		localStorage.setItem("dev3-streamer-mode", "on");
		renderCard({ agentId: "builtin-claude", accountId: "a1" });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect((await screen.findByText("Work")).hasAttribute("title")).toBe(false);
		expect(screen.getByText("work@example.com").hasAttribute("title")).toBe(false);
	});

	it("shows the project login email for a claude agent on the system login", async () => {
		renderCard({ agentId: "builtin-claude", accountId: null });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect(await screen.findByText("Project login")).toBeTruthy();
		expect(await screen.findByText("proj@example.com")).toBeTruthy();
	});

	it("shows no system email while the project lookup is pending, then the project email", async () => {
		let resolve!: (v: unknown) => void;
		vi.mocked(api.request.getProjectClaudeLogin).mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);
		renderCard({ agentId: "builtin-claude", accountId: null });
		await userEvent.setup().hover(screen.getByText("trigger"));
		await screen.findByText("Claude Code");
		await waitFor(() => expect(api.request.listAgentAccounts).toHaveBeenCalled());
		await act(async () => { await vi.mocked(api.request.listAgentAccounts).mock.results[0].value; });
		expect(screen.queryByText("system@example.com")).toBeNull();
		expect(screen.queryByText("System login")).toBeNull();
		resolve({ configDir: "/home/me/.claude-proj", identity: { email: "proj@example.com", organization: null, plan: null, planLabel: null, accountId: null } });
		expect(await screen.findByText("proj@example.com")).toBeTruthy();
	});

	it("keeps hiding the system email when the project lookup fails", async () => {
		vi.mocked(api.request.getProjectClaudeLogin).mockRejectedValueOnce(new Error("boom"));
		renderCard({ agentId: "builtin-claude", accountId: null });
		await userEvent.setup().hover(screen.getByText("trigger"));
		await screen.findByText("Claude Code");
		await act(async () => {
			await vi.mocked(api.request.listAgentAccounts).mock.results[0].value;
			await vi.mocked(api.request.getProjectClaudeLogin).mock.results[0].value.catch(() => {});
		});
		expect(screen.queryByText("system@example.com")).toBeNull();
	});

	it("does not look up the project login for a managed claude account", async () => {
		renderCard({ agentId: "builtin-claude", accountId: "a1" });
		await userEvent.setup().hover(screen.getByText("trigger"));
		await screen.findByText("Work");
		expect(api.request.getProjectClaudeLogin).not.toHaveBeenCalled();
	});

	it("does not look up the project login for codex on the system login", async () => {
		renderCard({ agentId: "builtin-codex", accountId: null });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect(await screen.findByText("System login")).toBeTruthy();
		expect(api.request.getProjectClaudeLogin).not.toHaveBeenCalled();
	});

	it("looks up the project login by project id for claude on the system login", async () => {
		renderCard({ agentId: "builtin-claude", accountId: null, projectId: "p9" });
		await userEvent.setup().hover(screen.getByText("trigger"));
		await screen.findByText("Project login");
		expect(api.request.getProjectClaudeLogin).toHaveBeenCalledWith({ projectId: "p9" });
	});

	it("shows the preset login for an agent whose preset pins the config dir", async () => {
		renderCard({ agentId: "pinned", accountId: null });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect(await screen.findByText("Preset login")).toBeTruthy();
	});

	it("shows the default account when no account was recorded", async () => {
		renderCard({ agentId: "builtin-claude" });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect(await screen.findByText("Default login")).toBeTruthy();
	});

	describe("native task whose saved panes are all parked", () => {
		const parked = {
			agentId: "builtin-claude",
			accountId: "a1",
			terminalBackend: "native" as const,
			sessionState: { panes: [{ agentCmd: "claude", agentId: "builtin-claude", configId: null, sessionId: null, parked: true }] },
		};

		it("shows the agents row with the running extra agent", async () => {
			vi.mocked(api.request.getNativeTaskAgents).mockResolvedValueOnce([
				{ paneId: "p2", agentCmd: "claude", agentId: "builtin-claude", configId: null, accountId: "a1" },
			]);
			renderCard(parked);
			await userEvent.setup().hover(screen.getByText("trigger"));
			expect(await screen.findByText("Work")).toBeTruthy();
			expect(screen.getByText("Agents")).toBeTruthy();
		});

		it("shows no agents row when there is no extra agent", async () => {
			vi.mocked(api.request.getNativeTaskAgents).mockClear();
			renderCard(parked);
			await userEvent.setup().hover(screen.getByText("trigger"));
			await waitFor(() => expect(api.request.getNativeTaskAgents).toHaveBeenCalled());
			expect(screen.queryByText("Agents")).toBeNull();
		});
	});

	it("neither mounts the list nor asks for native agents on a tmux task without agents", async () => {
		vi.mocked(api.request.getNativeTaskAgents).mockClear();
		renderCard({ agentId: null });
		await userEvent.setup().hover(screen.getByText("trigger"));
		expect(api.request.getNativeTaskAgents).not.toHaveBeenCalled();
	});
});
