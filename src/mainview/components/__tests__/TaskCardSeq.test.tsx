import { render, screen } from "@testing-library/react";
import TaskCard from "../TaskCard";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			moveTask: vi.fn(),
			deleteTask: vi.fn(),
			showConfirm: vi.fn(),
		},
	},
}));

const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	isDefault: true,
	configurations: [
		{ id: "claude-default", name: "Default", model: "sonnet" },
	],
	defaultConfigId: "claude-default",
};

const agents = [claudeAgent];

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
		seq: 1,
		projectId: "p1",
		title: "My task",
		description: "My task",
		status: "todo",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function renderCard(task: Task) {
	return render(
		<I18nProvider>
			<TaskCard
				task={task}
				project={project}
				dispatch={vi.fn()}
				navigate={vi.fn()}
				agents={agents}
				onLaunchVariants={vi.fn()}
				onAddAttempts={vi.fn()}
				onDragStart={vi.fn()}
				onTaskMoved={vi.fn()}
			/>
		</I18nProvider>,
	);
}

describe("TaskCard — seq display", () => {
	it("non-variant task shows #N badge", () => {
		renderCard(makeTask({ seq: 7 }));
		expect(screen.getByText("#7")).toBeInTheDocument();
	});

	it("variant task shows #N · Attempt M · Agent format", () => {
		renderCard(makeTask({
			seq: 3,
			status: "in-progress",
			worktreePath: "/tmp/wt",
			branchName: "dev3/test",
			variantIndex: 2,
			agentId: "builtin-claude",
			configId: "claude-default",
			groupId: "g1",
		}));
		expect(screen.getByText("#3 · Attempt 2 · Claude (Default · sonnet)")).toBeInTheDocument();
	});

	it("seq number is visible for todo task", () => {
		renderCard(makeTask({ seq: 10, status: "todo" }));
		expect(screen.getByText("#10")).toBeInTheDocument();
	});

	it("seq number is visible for in-progress task", () => {
		renderCard(makeTask({
			seq: 5,
			status: "in-progress",
			worktreePath: "/tmp/wt",
			branchName: "dev3/test",
		}));
		expect(screen.getByText("#5")).toBeInTheDocument();
	});

	it("seq number is visible for completed task", () => {
		renderCard(makeTask({ seq: 12, status: "completed" }));
		expect(screen.getByText("#12")).toBeInTheDocument();
	});

	it("seq number is visible for cancelled task", () => {
		renderCard(makeTask({ seq: 8, status: "cancelled" }));
		expect(screen.getByText("#8")).toBeInTheDocument();
	});
});
