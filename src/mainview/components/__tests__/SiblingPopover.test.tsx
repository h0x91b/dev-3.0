import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
		{ id: "claude-plan", name: "Plan (Opus 4.7)" },
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
	variants?: Task[];
	currentTaskId?: string;
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
				variants={props.variants ?? [makeSibling()]}
				currentTaskId={props.currentTaskId ?? "current"}
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
		variants: [
				makeSibling({ id: "s1", variantIndex: 1, status: "in-progress" }),
				makeSibling({ id: "s2", variantIndex: 2, status: "user-questions", title: "Renamed attempt" }),
			],
			currentTaskId: "s1",
		});

		expect(screen.getByText(/Variant 1/)).toBeInTheDocument();
		expect(screen.getByText(/Variant 2/)).toBeInTheDocument();
		expect(screen.getByText("Renamed attempt")).toBeInTheDocument();
		expect(screen.getByText("Current variant")).toBeInTheDocument();
		expect(screen.getByText("Siblings")).toBeInTheDocument();
	});

	it("calls navigate when clicking an active sibling", async () => {
		const navigate = vi.fn();
		const onClose = vi.fn();
		renderPopover({
			variants: [
				makeSibling({ id: "s1", variantIndex: 1, status: "in-progress" }),
				makeSibling({ id: "s2", variantIndex: 2, status: "user-questions" }),
			],
			currentTaskId: "s1",
			navigate,
			onClose,
		});

		await userEvent.click(screen.getByRole("button", { name: /Switch to Variant 2/ }));

		expect(navigate).toHaveBeenCalledWith({
			screen: "project",
			projectId: "p1",
			activeTaskId: "s2",
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("keeps completed siblings inert", async () => {
		const navigate = vi.fn();
		const onClose = vi.fn();
		renderPopover({
			variants: [makeSibling({ id: "s1", variantIndex: 1, status: "completed" })],
			navigate,
			onClose,
		});

		await userEvent.click(screen.getByRole("button", { name: /Variant 1/ }));

		expect(navigate).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes on Escape key", async () => {
		const onClose = vi.fn();
		renderPopover({ onClose });

		await userEvent.keyboard("{Escape}");

		expect(onClose).toHaveBeenCalled();
	});

	it("closes on click outside", async () => {
		const onClose = vi.fn();
		renderPopover({ onClose });

		await userEvent.click(document.body);

		expect(onClose).toHaveBeenCalled();
	});
});
