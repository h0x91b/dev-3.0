import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import TaskSwitcherOverlay from "../TaskSwitcherOverlay";
import type { SwitcherSession } from "../../hooks/useTaskSwitcher";
import type { Project, Task, TaskStatus } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { getTerminalPreview: vi.fn().mockResolvedValue("") } },
}));

function task(id: string, title: string, status: TaskStatus = "in-progress"): Task {
	return {
		id,
		seq: 1,
		projectId: "p1",
		title,
		description: "",
		status,
		overview: `overview of ${title}`,
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "",
		updatedAt: "",
	} as Task;
}

const project: Project = {
	id: "p1",
	name: "My Project",
	path: "/tmp/p1",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "",
};

function renderOverlay(session: SwitcherSession, handlers: {
	onHover?: (i: number) => void;
	onCommit?: (i: number) => void;
	onCancel?: () => void;
} = {}) {
	const onHover = handlers.onHover ?? vi.fn();
	const onCommit = handlers.onCommit ?? vi.fn();
	const onCancel = handlers.onCancel ?? vi.fn();
	render(
		<I18nProvider>
			<TaskSwitcherOverlay
				session={session}
				projectById={new Map([[project.id, project]])}
				onHover={onHover}
				onCommit={onCommit}
				onCancel={onCancel}
			/>
		</I18nProvider>,
	);
	return { onHover, onCommit, onCancel };
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("TaskSwitcherOverlay", () => {
	const session: SwitcherSession = {
		scope: "project",
		items: [task("a", "Alpha"), task("b", "Beta")],
		index: 0,
	};

	it("renders a row per task with title and overview", () => {
		renderOverlay(session);
		expect(screen.getByText("Alpha")).toBeInTheDocument();
		expect(screen.getByText("Beta")).toBeInTheDocument();
		expect(screen.getByText("overview of Alpha")).toBeInTheDocument();
	});

	it("marks the selected row with aria-selected", () => {
		renderOverlay({ ...session, index: 1 });
		const options = screen.getAllByRole("option");
		expect(options[0]).toHaveAttribute("aria-selected", "false");
		expect(options[1]).toHaveAttribute("aria-selected", "true");
	});

	it("commits the clicked row", async () => {
		const user = userEvent.setup();
		const { onCommit } = renderOverlay(session);
		await user.click(screen.getByText("Beta"));
		expect(onCommit).toHaveBeenCalledWith(1);
	});

	it("hovering a row reports its index", async () => {
		const user = userEvent.setup();
		const { onHover } = renderOverlay(session);
		await user.hover(screen.getByText("Beta"));
		expect(onHover).toHaveBeenCalledWith(1);
	});

	it("shows the project name in global scope", () => {
		renderOverlay({ ...session, scope: "global" });
		expect(screen.getAllByText("My Project").length).toBeGreaterThan(0);
	});
});
