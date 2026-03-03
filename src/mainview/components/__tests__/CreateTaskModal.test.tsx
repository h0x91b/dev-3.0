import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateTaskModal from "../CreateTaskModal";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import type { AppAction } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			createTask: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

import { api } from "../../rpc";

const mockedApi = vi.mocked(api, true);

const mockProject: Project = {
	id: "p1",
	name: "Test Project",
	path: "/home/user/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	clonePaths: [],
	createdAt: "2025-01-01T00:00:00Z",
};

const mockTask: Task = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	title: "Test task",
	description: "Test task description",
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
};

function renderModal(props: {
	dispatch?: React.Dispatch<AppAction>;
	onClose?: () => void;
	onCreateAndRun?: (task: Task) => void;
} = {}) {
	return render(
		<I18nProvider>
			<CreateTaskModal
				project={mockProject}
				dispatch={props.dispatch ?? vi.fn()}
				onClose={props.onClose ?? vi.fn()}
				onCreateAndRun={props.onCreateAndRun}
			/>
		</I18nProvider>,
	);
}

describe("CreateTaskModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.createTask.mockResolvedValue(mockTask);
	});

	it("shows Create & Run button when onCreateAndRun is provided", () => {
		renderModal({ onCreateAndRun: vi.fn() });
		expect(screen.getByText("Create & Run")).toBeInTheDocument();
	});

	it("does not show Create & Run button when onCreateAndRun is omitted", () => {
		renderModal();
		expect(screen.queryByText("Create & Run")).not.toBeInTheDocument();
	});

	it("shows dual hint text when onCreateAndRun is provided", () => {
		renderModal({ onCreateAndRun: vi.fn() });
		expect(screen.getByText(/\u2318\u21e7Enter/)).toBeInTheDocument();
	});

	it("shows simple hint text when onCreateAndRun is omitted", () => {
		renderModal();
		expect(screen.getByText("\u2318Enter to create")).toBeInTheDocument();
	});

	it("Create & Run creates task and calls onCreateAndRun", async () => {
		const onCreateAndRun = vi.fn();
		const dispatch = vi.fn();
		renderModal({ onCreateAndRun, dispatch });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.click(screen.getByText("Create & Run"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "My new task",
			});
		});
		expect(dispatch).toHaveBeenCalledWith({ type: "addTask", task: mockTask });
		expect(onCreateAndRun).toHaveBeenCalledWith(mockTask);
	});

	it("plain Create still calls onClose", async () => {
		const onClose = vi.fn();
		const onCreateAndRun = vi.fn();
		renderModal({ onClose, onCreateAndRun });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.click(screen.getByText("Create"));

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
		expect(onCreateAndRun).not.toHaveBeenCalled();
	});

	it("Cmd+Shift+Enter triggers Create & Run", async () => {
		const onCreateAndRun = vi.fn();
		renderModal({ onCreateAndRun });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.keyboard("{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");

		await waitFor(() => {
			expect(onCreateAndRun).toHaveBeenCalledWith(mockTask);
		});
	});

	it("Cmd+Enter triggers plain Create, not Create & Run", async () => {
		const onClose = vi.fn();
		const onCreateAndRun = vi.fn();
		renderModal({ onClose, onCreateAndRun });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
		expect(onCreateAndRun).not.toHaveBeenCalled();
	});
});
