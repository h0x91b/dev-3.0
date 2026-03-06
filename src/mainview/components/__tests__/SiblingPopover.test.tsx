import { render, screen, fireEvent } from "@testing-library/react";
import SiblingPopover from "../SiblingPopover";
import { I18nProvider } from "../../i18n";
import type { CodingAgent, Task } from "../../../shared/types";
import type { Route } from "../../state";

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

const agents = [claudeAgent];

function makeSibling(overrides?: Partial<Task>): Task {
	return {
		id: "s1",
		seq: 5,
		projectId: "p1",
		title: "Test task",
		description: "Test task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "dev3/test",
		groupId: "group-1",
		variantIndex: 1,
		agentId: "builtin-claude",
		configId: "claude-default",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function renderPopover(props: {
	siblings?: Task[];
	navigate?: (route: Route) => void;
	onClose?: () => void;
}) {
	const anchor = document.createElement("button");
	document.body.appendChild(anchor);
	anchor.getBoundingClientRect = () => ({
		top: 100,
		left: 100,
		bottom: 120,
		right: 200,
		width: 100,
		height: 20,
		x: 100,
		y: 100,
		toJSON: () => {},
	});

	const result = render(
		<I18nProvider>
			<SiblingPopover
				siblings={props.siblings ?? [makeSibling()]}
				agents={agents}
				navigate={props.navigate ?? vi.fn()}
				onClose={props.onClose ?? vi.fn()}
				anchorEl={anchor}
				projectId="p1"
			/>
		</I18nProvider>,
	);

	return { ...result, anchor };
}

describe("SiblingPopover", () => {
	it("renders sibling list with status and agent info", () => {
		renderPopover({
			siblings: [
				makeSibling({ id: "s1", variantIndex: 1, status: "in-progress" }),
				makeSibling({ id: "s2", variantIndex: 2, status: "user-questions" }),
			],
		});

		expect(screen.getByText(/Attempt 1/)).toBeInTheDocument();
		expect(screen.getByText(/Attempt 2/)).toBeInTheDocument();
		expect(screen.getByText("Siblings")).toBeInTheDocument();
	});

	it("calls navigate when clicking an active sibling", () => {
		const navigate = vi.fn();
		const onClose = vi.fn();
		renderPopover({
			siblings: [makeSibling({ id: "s1", variantIndex: 1, status: "in-progress" })],
			navigate,
			onClose,
		});

		fireEvent.click(screen.getByText(/Attempt 1/));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
			activeTaskId: "s1",
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("closes popover but does not navigate for completed siblings", () => {
		const navigate = vi.fn();
		const onClose = vi.fn();
		renderPopover({
			siblings: [makeSibling({ id: "s1", variantIndex: 1, status: "completed" })],
			navigate,
			onClose,
		});

		fireEvent.click(screen.getByText(/Attempt 1/));

		expect(navigate).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("closes on Escape key", () => {
		const onClose = vi.fn();
		renderPopover({ onClose });

		fireEvent.keyDown(document, { key: "Escape" });

		expect(onClose).toHaveBeenCalled();
	});

	it("closes on click outside", () => {
		const onClose = vi.fn();
		renderPopover({ onClose });

		fireEvent.mouseDown(document.body);

		expect(onClose).toHaveBeenCalled();
	});
});
