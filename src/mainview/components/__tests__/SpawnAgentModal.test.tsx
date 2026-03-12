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
		{ id: "claude-plan", name: "Plan (Opus)", model: "opus" },
	],
	defaultConfigId: "claude-default",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [
		{ id: "codex-default", name: "Default", model: "gpt-5.4" },
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
						{ id: "claude-plan", name: "Plan (Opus)", model: "opus" },
					],
					defaultConfigId: "claude-default",
				},
				{
					id: "builtin-codex",
					name: "Codex",
					baseCommand: "codex",
					isDefault: true,
					configurations: [
						{ id: "codex-default", name: "Default", model: "gpt-5.4" },
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

	it("shows agent and config selects after loading", async () => {
		renderModal();
		await vi.waitFor(() => {
			expect(screen.getByText("Agent")).toBeInTheDocument();
			expect(screen.getByText("Configuration")).toBeInTheDocument();
		});
	});

	it("defaults to global default agent and config", async () => {
		renderModal();
		await vi.waitFor(() => {
			const agentBtn = document.getElementById("spawn-agent") as HTMLButtonElement;
			expect(agentBtn?.textContent?.trim()).toBe("Claude");
		});
		const configBtn = document.getElementById("spawn-config") as HTMLButtonElement;
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

	it("switches agent and resets config", async () => {
		const user = userEvent.setup();
		renderModal();

		await vi.waitFor(() => {
			expect(document.getElementById("spawn-agent")).toBeInTheDocument();
		});

		const agentBtn = document.getElementById("spawn-agent") as HTMLButtonElement;
		await user.click(agentBtn);
		const codexOption = screen.getByText("Codex", { selector: "button" });
		await user.click(codexOption);

		const configBtn = document.getElementById("spawn-config") as HTMLButtonElement;
		expect(configBtn?.textContent?.trim()).toBe("Default");
	});
});
