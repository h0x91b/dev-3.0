import { render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import ActiveTasksSidebar from "../ActiveTasksSidebar";
import type { CodingAgent, Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTerminalPreview: vi.fn(),
		},
	},
}));

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "claude-bypass", name: "Bypass (By Default)" },
	],
	defaultConfigId: "claude-bypass",
};

const codexAgent: CodingAgent = {
	id: "builtin-codex",
	name: "Codex",
	baseCommand: "codex",
	isDefault: true,
	configurations: [
		{ id: "codex-default", name: "Default (GPT-5.4 Heavy Bypass)", model: "gpt-5.4" },
	],
	defaultConfigId: "codex-default",
};

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 494,
		projectId: "p1",
		title: "Привет! как сам?",
		description: "Привет! как сам?",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "feat/test",
		groupId: "g1",
		variantIndex: 1,
		agentId: "builtin-claude",
		configId: "claude-bypass",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

describe("ActiveTasksSidebar", () => {
	it("shows agent-first identity with compact config and variant dots", () => {
		render(
			<I18nProvider>
				<ActiveTasksSidebar
					project={project}
					tasks={[
						makeTask(),
						makeTask({
							id: "t2",
							variantIndex: 2,
							agentId: "builtin-codex",
							configId: "codex-default",
						}),
					]}
					activeTaskId="t1"
					dispatch={vi.fn()}
					navigate={vi.fn()}
					agents={[claudeAgent, codexAgent]}
					bellCounts={new Map()}
					taskPorts={new Map()}
					onSwitchToBoard={vi.fn()}
				/>
			</I18nProvider>,
		);

		expect(screen.getByRole("img", { name: "Claude" })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Codex" })).toBeInTheDocument();
		expect(screen.getByText("Claude · By Default · Bypass")).toBeInTheDocument();
		expect(screen.getByText("Codex · GPT-5.4 Heavy Bypass")).toBeInTheDocument();
		expect(screen.getByTestId("variant-indicator-t1")).toBeInTheDocument();
		expect(screen.getAllByText("#494")).toHaveLength(2);
	});
});
