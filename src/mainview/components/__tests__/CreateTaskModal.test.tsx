import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateTaskModal from "../CreateTaskModal";
import { splitBranchWords, matchesBranchQuery } from "../BranchSelector";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import type { AppAction } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			createTask: vi.fn(),
			listBranches: vi.fn(),
			fetchBranches: vi.fn(),
			setTaskLabels: vi.fn(),
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

	it("shows Save & Start button when onCreateAndRun is provided", () => {
		renderModal({ onCreateAndRun: vi.fn() });
		expect(screen.getByText("Save & Start")).toBeInTheDocument();
	});

	it("does not show Save & Start button when onCreateAndRun is omitted", () => {
		renderModal();
		expect(screen.queryByText("Save & Start")).not.toBeInTheDocument();
	});

	it("shows dual hint text when onCreateAndRun is provided", () => {
		renderModal({ onCreateAndRun: vi.fn() });
		expect(screen.getByText(/\u2318\u21e7Enter/)).toBeInTheDocument();
	});

	it("shows simple hint text when onCreateAndRun is omitted", () => {
		renderModal();
		expect(screen.getByText("\u2318Enter to save")).toBeInTheDocument();
	});

	it("Save & Start creates task and calls onCreateAndRun", async () => {
		const onCreateAndRun = vi.fn();
		const dispatch = vi.fn();
		renderModal({ onCreateAndRun, dispatch });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.click(screen.getByText("Save & Start"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "My new task",
			});
		});
		expect(dispatch).toHaveBeenCalledWith({ type: "addTask", task: mockTask });
		expect(onCreateAndRun).toHaveBeenCalledWith(mockTask);
	});

	it("plain Save still calls onClose", async () => {
		const onClose = vi.fn();
		const onCreateAndRun = vi.fn();
		renderModal({ onClose, onCreateAndRun });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
		expect(onCreateAndRun).not.toHaveBeenCalled();
	});

	it("Cmd+Shift+Enter triggers Save & Start", async () => {
		const onCreateAndRun = vi.fn();
		renderModal({ onCreateAndRun });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.keyboard("{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");

		await waitFor(() => {
			expect(onCreateAndRun).toHaveBeenCalledWith(mockTask);
		});
	});

	it("Cmd+Enter triggers plain Save, not Save & Start", async () => {
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

	it("Ctrl+Enter triggers plain Create (Linux/Windows)", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.keyboard("{Control>}{Enter}{/Control}");

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
	});

	it("Ctrl+Shift+Enter triggers Save & Start (Linux/Windows)", async () => {
		const onCreateAndRun = vi.fn();
		renderModal({ onCreateAndRun });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "My new task");
		await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");

		await waitFor(() => {
			expect(onCreateAndRun).toHaveBeenCalledWith(mockTask);
		});
	});

	it("clicking outside the modal does NOT close it", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const overlay = screen.getByText("New Task").closest(".fixed");
		if (overlay) await userEvent.click(overlay);

		expect(onClose).not.toHaveBeenCalled();
	});

	it("Cancel with empty description closes immediately", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		await userEvent.click(screen.getByText("Cancel"));

		expect(onClose).toHaveBeenCalled();
	});

	it("Cancel with filled description shows inline discard confirmation", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.click(screen.getByText("Cancel"));

		expect(screen.getByText("Discard")).toBeInTheDocument();
		expect(screen.getByText("Keep editing")).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("clicking Discard in confirmation closes the modal", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.click(screen.getByText("Cancel"));
		await userEvent.click(screen.getByText("Discard"));

		expect(onClose).toHaveBeenCalled();
	});

	it("clicking Keep editing hides confirmation and stays open", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.click(screen.getByText("Cancel"));
		await userEvent.click(screen.getByText("Keep editing"));

		expect(screen.queryByText("Discard")).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("Escape with filled description shows inline discard confirmation", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.keyboard("{Escape}");

		expect(screen.getByText("Discard")).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("Escape with empty description closes immediately", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		await userEvent.keyboard("{Escape}");

		expect(onClose).toHaveBeenCalled();
	});

	// ---- Branch selector ----

	it("branch section starts collapsed", () => {
		renderModal();
		expect(screen.getByText("Use existing branch")).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Type to search branches...")).not.toBeInTheDocument();
	});

	it("clicking 'Use existing branch' expands the selector", async () => {
		mockedApi.request.listBranches.mockResolvedValue([]);
		renderModal();

		await userEvent.click(screen.getByText("Use existing branch"));

		expect(screen.getByPlaceholderText("Type to search branches...")).toBeInTheDocument();
	});

	it("selecting a branch shows it as a chip", async () => {
		mockedApi.request.listBranches.mockResolvedValue([
			{ name: "feature/login", isRemote: false },
			{ name: "origin/main", isRemote: true },
		]);
		renderModal();

		await userEvent.click(screen.getByText("Use existing branch"));
		const input = screen.getByPlaceholderText("Type to search branches...");
		await userEvent.click(input);

		await waitFor(() => {
			expect(screen.getByText("feature/login")).toBeInTheDocument();
		});
		await userEvent.click(screen.getByText("feature/login"));

		// Now the chip should be visible and the input should be gone
		expect(screen.getByText("feature/login")).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Type to search branches...")).not.toBeInTheDocument();
	});

	it("clearing selected branch returns to input", async () => {
		mockedApi.request.listBranches.mockResolvedValue([
			{ name: "feature/login", isRemote: false },
		]);
		renderModal();

		await userEvent.click(screen.getByText("Use existing branch"));
		const input = screen.getByPlaceholderText("Type to search branches...");
		await userEvent.click(input);

		await waitFor(() => {
			expect(screen.getByText("feature/login")).toBeInTheDocument();
		});
		await userEvent.click(screen.getByText("feature/login"));

		// Click the X button to clear
		const clearButton = screen.getByText("feature/login").parentElement?.querySelector("button");
		expect(clearButton).toBeTruthy();
		await userEvent.click(clearButton!);

		expect(screen.getByPlaceholderText("Type to search branches...")).toBeInTheDocument();
	});

	it("passes existingBranch to createTask when a branch is selected", async () => {
		mockedApi.request.listBranches.mockResolvedValue([
			{ name: "feature/login", isRemote: false },
		]);
		const dispatch = vi.fn();
		const onClose = vi.fn();
		renderModal({ dispatch, onClose });

		// Expand branch selector and pick a branch
		await userEvent.click(screen.getByText("Use existing branch"));
		const input = screen.getByPlaceholderText("Type to search branches...");
		await userEvent.click(input);
		await waitFor(() => {
			expect(screen.getByText("feature/login")).toBeInTheDocument();
		});
		await userEvent.click(screen.getByText("feature/login"));

		// Type description and create
		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Continue login");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "Continue login",
				existingBranch: "feature/login",
			});
		});
	});

	it("does not pass existingBranch when no branch is selected", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "New task");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "New task",
			});
		});
	});

	it("Fetch button calls fetchBranches and updates list", async () => {
		mockedApi.request.listBranches.mockResolvedValue([]);
		mockedApi.request.fetchBranches.mockResolvedValue([
			{ name: "origin/new-feature", isRemote: true },
		]);
		renderModal();

		await userEvent.click(screen.getByText("Use existing branch"));
		await userEvent.click(screen.getByText("Fetch"));

		await waitFor(() => {
			expect(mockedApi.request.fetchBranches).toHaveBeenCalledWith({ projectId: "p1" });
		});
	});
});

// ================================================================
// Pure functions: splitBranchWords / matchesBranchQuery
// ================================================================

describe("splitBranchWords", () => {
	it("splits on slashes", () => {
		expect(splitBranchWords("origin/feature/login")).toEqual(["origin", "feature", "login"]);
	});

	it("splits on hyphens", () => {
		expect(splitBranchWords("fix-auth-bug")).toEqual(["fix", "auth", "bug"]);
	});

	it("splits on underscores", () => {
		expect(splitBranchWords("fix_auth_bug")).toEqual(["fix", "auth", "bug"]);
	});

	it("splits on dots", () => {
		expect(splitBranchWords("release.v2.1")).toEqual(["release", "v2", "1"]);
	});

	it("splits on camelCase boundaries", () => {
		expect(splitBranchWords("myFeatureBranch")).toEqual(["my", "feature", "branch"]);
	});

	it("splits on mixed delimiters and camelCase", () => {
		expect(splitBranchWords("origin/fix-myBugFix_v2")).toEqual(["origin", "fix", "my", "bug", "fix", "v2"]);
	});

	it("lowercases all words", () => {
		expect(splitBranchWords("Main")).toEqual(["main"]);
		expect(splitBranchWords("HOTFIX")).toEqual(["hotfix"]);
	});

	it("handles single word", () => {
		expect(splitBranchWords("main")).toEqual(["main"]);
	});
});

describe("matchesBranchQuery", () => {
	it("empty query matches everything", () => {
		expect(matchesBranchQuery("origin/feature", "")).toBe(true);
	});

	it("matches word start, not substring", () => {
		expect(matchesBranchQuery("origin/main", "m")).toBe(true);
		expect(matchesBranchQuery("origin/main", "o")).toBe(true);
		// "g" should NOT match — no word starts with "g" in "origin/main"
		expect(matchesBranchQuery("origin/main", "g")).toBe(false);
	});

	it("matches camelCase word boundaries", () => {
		expect(matchesBranchQuery("myFeatureBranch", "f")).toBe(true);
		expect(matchesBranchQuery("myFeatureBranch", "b")).toBe(true);
		expect(matchesBranchQuery("myFeatureBranch", "e")).toBe(false);
	});

	it("multiple tokens must all match different words", () => {
		expect(matchesBranchQuery("dev3/fix-auth-race", "fix auth")).toBe(true);
		expect(matchesBranchQuery("dev3/fix-auth-race", "fix login")).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(matchesBranchQuery("origin/Main", "MAIN")).toBe(true);
		expect(matchesBranchQuery("origin/Main", "main")).toBe(true);
	});

	it("matches kebab-case words", () => {
		expect(matchesBranchQuery("fix-login-bug", "log")).toBe(true);
		expect(matchesBranchQuery("fix-login-bug", "ogin")).toBe(false);
	});

	it("matches partial word prefix", () => {
		expect(matchesBranchQuery("feature/authentication", "auth")).toBe(true);
		expect(matchesBranchQuery("feature/authentication", "feat")).toBe(true);
	});
});
