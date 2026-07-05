import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SpawnAgentModal from "../SpawnAgentModal";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, GlobalSettings, Project, Task } from "../../../shared/types";

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "claude-default", name: "Default", model: "sonnet" },
		{ id: "claude-plan", name: "Plan (Opus 4.7)" },
	],
	defaultConfigId: "claude-default",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [
		{ id: "codex-default", name: "Default", model: "gpt-5.5" },
	],
	defaultConfigId: "codex-default",
};

const agents = [claudeAgent, codexAgent];

const globalSettings: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-default",
	taskDropPosition: "top",
	updateChannel: "stable",
};

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([
				{
					id: "builtin-claude",
					name: "Claude",
					baseCommand: "claude",
					isDefault: true,
					configurations: [
						{ id: "claude-default", name: "Default", model: "sonnet" },
						{ id: "claude-plan", name: "Plan (Opus 4.7)" },
					],
					defaultConfigId: "claude-default",
				},
				{
					id: "builtin-codex",
					name: "Codex",
					baseCommand: "codex",
					isDefault: true,
					configurations: [
						{ id: "codex-default", name: "Default", model: "gpt-5.5" },
					],
					defaultConfigId: "codex-default",
				},
			]),
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
			}),
			spawnAgentInTask: vi.fn().mockResolvedValue(undefined),
			checkAgentAvailability: vi.fn().mockResolvedValue([
				{ agentId: "builtin-claude", name: "Claude", baseCommand: "claude", installed: true, resolvedPath: "/usr/local/bin/claude" },
				{ agentId: "builtin-codex", name: "Codex", baseCommand: "codex", installed: true, resolvedPath: "/usr/local/bin/codex" },
			]),
		},
	},
}));

import { api } from "../../rpc";
const mockedApi = vi.mocked(api, true);

const baseTask: Task = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	title: "Test task",
	description: "Test description",
	status: "in-progress",
	baseBranch: "main",
	worktreePath: "/tmp/test-worktree",
	branchName: "feat/test",
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2025-01-01T00:00:00Z",
	updatedAt: "2025-01-01T00:00:00Z",
};

const baseProject: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function renderModal(onClose = vi.fn()) {
	return render(
		<I18nProvider>
			<SpawnAgentModal task={baseTask} project={baseProject} onClose={onClose} />
		</I18nProvider>,
	);
}

describe("SpawnAgentModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.getAgents.mockResolvedValue(agents);
		mockedApi.request.getGlobalSettings.mockResolvedValue(globalSettings);
	});

	it("renders the modal title", async () => {
		renderModal();
		expect(screen.getByText("Spawn Agent")).toBeInTheDocument();
	});

	it("shows the Provider/Model/Mode picker after loading", async () => {
		renderModal();
		await vi.waitFor(() => {
			expect(screen.getByText("Provider")).toBeInTheDocument();
			expect(screen.getByText("Model")).toBeInTheDocument();
			expect(screen.getByText("Mode")).toBeInTheDocument();
		});
	});

	it("defaults to global default agent and config", async () => {
		renderModal();
		await vi.waitFor(() => {
			const agentBtn = document.getElementById("spawn-provider") as HTMLButtonElement;
			expect(agentBtn?.textContent?.trim()).toBe("Claude");
		});
		const configBtn = document.getElementById("spawn-mode") as HTMLButtonElement;
		expect(configBtn?.textContent?.trim()).toBe("Default");
	});

	it("calls spawnAgentInTask on Spawn click", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderModal(onClose);

		await vi.waitFor(() => {
			expect(screen.getByText("Spawn")).toBeInTheDocument();
		});

		await user.click(screen.getByText("Spawn"));

		await vi.waitFor(() => {
			expect(mockedApi.request.spawnAgentInTask).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				agentId: "builtin-claude",
				configId: "claude-default",
			});
		});

		expect(onClose).toHaveBeenCalled();
	});

	it("shows error when spawn fails", async () => {
		const user = userEvent.setup();
		mockedApi.request.spawnAgentInTask.mockRejectedValue(new Error("tmux error"));
		renderModal();

		await vi.waitFor(() => {
			expect(screen.getByText("Spawn")).toBeInTheDocument();
		});

		await user.click(screen.getByText("Spawn"));

		await vi.waitFor(() => {
			expect(screen.getByText(/Failed to spawn.*tmux error/)).toBeInTheDocument();
		});
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		renderModal(onClose);
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("closes on backdrop click", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderModal(onClose);

		const backdrop = screen.getByText("Spawn Agent").closest(".fixed");
		if (backdrop) await user.click(backdrop);

		expect(onClose).toHaveBeenCalled();
	});

	it("ignores stale defaultConfigId that belongs to a removed agent", async () => {
		// defaultAgentId points to a deleted agent, defaultConfigId belongs to it
		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "deleted-agent",
			defaultConfigId: "deleted-config",
			taskDropPosition: "top",
			updateChannel: "stable",
		});
		renderModal();

		await vi.waitFor(() => {
			const agentBtn = document.getElementById("spawn-provider") as HTMLButtonElement;
			// Falls back to first agent (Claude)
			expect(agentBtn?.textContent?.trim()).toBe("Claude");
		});

		const configBtn = document.getElementById("spawn-mode") as HTMLButtonElement;
		// Should NOT show blank — should fall back to Claude's defaultConfigId
		expect(configBtn?.textContent?.trim()).toBe("Default");
	});

	it("switches agent and resets config", async () => {
		const user = userEvent.setup();
		renderModal();

		await vi.waitFor(() => {
			expect(document.getElementById("spawn-provider")).toBeInTheDocument();
		});

		const agentBtn = document.getElementById("spawn-provider") as HTMLButtonElement;
		await user.click(agentBtn);
		const codexEl = screen.getByText("Codex");
		const codexOption = codexEl.closest("button") ?? codexEl;
		await user.click(codexOption);

		const configBtn = document.getElementById("spawn-mode") as HTMLButtonElement;
		expect(configBtn?.textContent?.trim()).toBe("Default");
	});

	describe("Enter key", () => {
		// Same class of bug as LaunchVariantsModal: the agent/config pickers render
		// as <button>, so Enter while one is focused must NOT spawn an agent.
		it("does not spawn when the agent Select button is focused", async () => {
			renderModal();
			await vi.waitFor(() => {
				expect(document.getElementById("spawn-provider")).toBeInTheDocument();
			});

			(document.getElementById("spawn-provider") as HTMLButtonElement).focus();
			await userEvent.keyboard("{Enter}");

			expect(mockedApi.request.spawnAgentInTask).not.toHaveBeenCalled();
		});

		it("spawns on Enter when no interactive control is focused", async () => {
			renderModal();
			// Wait until agents + globalSettings have loaded (Enter is gated on globalSettings).
			await vi.waitFor(() => {
				const agentBtn = document.getElementById("spawn-provider") as HTMLButtonElement;
				expect(agentBtn?.textContent?.trim()).toBe("Claude");
			});

			// Focus the dialog container (no control) then press Enter.
			(screen.getByRole("dialog") as HTMLElement).focus();
			await userEvent.keyboard("{Enter}");

			await vi.waitFor(() => {
				expect(mockedApi.request.spawnAgentInTask).toHaveBeenCalled();
			});
		});

		it("does not spawn on Cmd/Ctrl/Shift+Enter", async () => {
			renderModal();
			await vi.waitFor(() => {
				expect(screen.getByText("Spawn")).toBeInTheDocument();
			});

			await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
			await userEvent.keyboard("{Control>}{Enter}{/Control}");
			await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

			expect(mockedApi.request.spawnAgentInTask).not.toHaveBeenCalled();
		});
	});

	describe("focus trap", () => {
		it("moves focus into the dialog on open", async () => {
			renderModal();
			const dialog = await screen.findByRole("dialog");
			expect(dialog.contains(document.activeElement)).toBe(true);
		});

		it("keeps Tab inside the dialog", async () => {
			const user = userEvent.setup();
			renderModal();
			const dialog = await screen.findByRole("dialog");
			await vi.waitFor(() => {
				expect(document.getElementById("spawn-provider")).toBeInTheDocument();
			});

			const outside = document.createElement("button");
			document.body.appendChild(outside);
			for (let i = 0; i < 8; i++) {
				await user.tab();
				expect(dialog.contains(document.activeElement)).toBe(true);
				expect(document.activeElement).not.toBe(outside);
			}
			document.body.removeChild(outside);
		});
	});
});
