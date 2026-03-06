import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KanbanBoard from "../KanbanBoard";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn().mockResolvedValue([]),
			getGlobalSettings: vi.fn().mockResolvedValue({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskDropPosition: "top",
				updateChannel: "stable",
			}),
		},
	},
}));

vi.mock("../../analytics", () => ({ trackEvent: vi.fn() }));

const project: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function renderBoard() {
	return render(
		<I18nProvider>
			<KanbanBoard
				project={project}
				tasks={[]}
				dispatch={vi.fn()}
				navigate={vi.fn()}
				bellCounts={new Map()}
			/>
		</I18nProvider>,
	);
}

describe("KanbanBoard keyboard shortcuts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("Cmd+N opens the create task modal", async () => {
		renderBoard();
		expect(screen.queryByText("New Task")).not.toBeInTheDocument();
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
	});

	it("Ctrl+N opens the create task modal", async () => {
		renderBoard();
		expect(screen.queryByText("New Task")).not.toBeInTheDocument();
		await userEvent.keyboard("{Control>}n{/Control}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
	});

	it("Cmd+N does nothing when the modal is already open", async () => {
		renderBoard();
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
		// Second press should not open a second modal
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getAllByText("New Task")).toHaveLength(1);
	});

	it("Escape closes the create task modal after Cmd+N", async () => {
		renderBoard();
		await userEvent.keyboard("{Meta>}n{/Meta}");
		expect(screen.getByText("New Task")).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByText("New Task")).not.toBeInTheDocument();
	});
});
