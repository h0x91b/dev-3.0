import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BugHuntersLightbox from "../BugHuntersLightbox";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			checkAgentAvailability: vi.fn(),
			getAgents: vi.fn(),
			getGlobalSettings: vi.fn(),
			spawnBugHuntersInTask: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackAgentLaunched: vi.fn(),
	trackEvent: vi.fn(),
}));

vi.mock("../AgentConfigPicker", () => ({
	default: () => <div data-testid="agent-picker" />,
}));

import { api } from "../../rpc";

const project: Project = {
	id: "project-1",
	name: "Test project",
	path: "/tmp/project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const task: Task = {
	id: "task-1",
	seq: 1,
	projectId: project.id,
	title: "Test task",
	description: "",
	status: "in-progress",
	baseBranch: "main",
	worktreePath: "/tmp/worktree",
	branchName: "fix/test",
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("BugHuntersLightbox", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.checkAgentAvailability).mockResolvedValue([]);
		vi.mocked(api.request.getAgents).mockResolvedValue([
			{ id: "builtin-claude", name: "Claude", baseCommand: "claude", configurations: [], defaultConfigId: "claude-default" },
		]);
		vi.mocked(api.request.getGlobalSettings).mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskDropPosition: "top",
			updateChannel: "stable",
		});
	});

	it("explains how to hand hunter findings back to the main agent", async () => {
		render(
			<I18nProvider>
				<BugHuntersLightbox task={task} project={project} onClose={vi.fn()} />
			</I18nProvider>,
		);

		expect(await screen.findByText("What happens next")).toBeInTheDocument();
		expect(screen.getByText(/Hunters add confirmed findings as notes/)).toBeInTheDocument();
		expect(screen.getByText("Review the latest [bug-hunt] notes on this task and work through the findings.")).toBeInTheDocument();
	});

	// The seq-1394 regression entered exactly here: the picker's defaults, one
	// click on Launch hunters, and the backend then split a tmux pane on a native
	// task. The dialog must send the launch and must show a failure instead of
	// closing on one.
	it("launches the picker's default hunter count and closes", async () => {
		vi.mocked(api.request.spawnBugHuntersInTask).mockResolvedValue({ spawned: 3 });
		const onClose = vi.fn();
		render(
			<I18nProvider>
				<BugHuntersLightbox task={task} project={project} onClose={onClose} />
			</I18nProvider>,
		);

		await userEvent.click(await screen.findByRole("button", { name: /Launch 3 hunters/ }));

		expect(api.request.spawnBugHuntersInTask).toHaveBeenCalledWith({
			taskId: task.id,
			projectId: project.id,
			agentId: "builtin-claude",
			configId: "claude-default",
			count: 3,
			accountId: undefined,
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("shows the backend's failure and stays open instead of pretending hunters started", async () => {
		vi.mocked(api.request.spawnBugHuntersInTask).mockRejectedValue(
			new Error("the task terminal is not running, so it has no pane to split"),
		);
		const onClose = vi.fn();
		render(
			<I18nProvider>
				<BugHuntersLightbox task={task} project={project} onClose={onClose} />
			</I18nProvider>,
		);

		await userEvent.click(await screen.findByRole("button", { name: /Launch 3 hunters/ }));

		expect(await screen.findByText(/the task terminal is not running/)).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});
});
