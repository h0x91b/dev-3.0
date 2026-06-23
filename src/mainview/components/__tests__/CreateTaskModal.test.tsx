import { act, render, screen, waitFor } from "@testing-library/react";
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
			createLabel: vi.fn(),
			getProjectCurrentBranch: vi.fn(),
			uploadFileBase64: vi.fn(),
			uploadImageBase64: vi.fn(),
			readImageBase64: vi.fn(),
			openImageFile: vi.fn(),
			listAgentSkills: vi.fn(),
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
	project?: Project;
} = {}) {
	return render(
		<I18nProvider>
			<CreateTaskModal
				project={props.project ?? mockProject}
				dispatch={props.dispatch ?? vi.fn()}
				onClose={props.onClose ?? vi.fn()}
				onCreateAndRun={props.onCreateAndRun}
			/>
		</I18nProvider>,
	);
}

function makeFileList(files: File[]): FileList {
	return {
		length: files.length,
		item: (index: number) => files[index] ?? null,
		...Object.fromEntries(files.map((file, index) => [index, file])),
	} as unknown as FileList;
}

function dispatchDrop(target: Element, files: File[]) {
	const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: {
			files: makeFileList(files),
			dropEffect: "copy" as const,
		},
	});
	act(() => {
		target.dispatchEvent(event);
	});
}

function dispatchTextPaste(target: Element, text: string) {
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			items: [{ type: "text/plain", kind: "string" }],
			getData: (type: string) => (type === "text/plain" ? text : ""),
		},
	});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

describe("CreateTaskModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.createTask.mockResolvedValue(mockTask);
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false, behindOrigin: 0 });
		mockedApi.request.uploadFileBase64.mockResolvedValue({ path: "/tmp/uploaded-drop.png" });
		mockedApi.request.uploadImageBase64.mockResolvedValue({ path: "/tmp/uploaded-drop.png" });
		mockedApi.request.readImageBase64.mockResolvedValue({ dataUrl: "data:image/png;base64,abc" });
		mockedApi.request.listAgentSkills.mockResolvedValue([
			{ name: "dev3", description: "Manage dev3 tasks", source: "claude" },
			{ name: "dev3-bug-hunter", description: "Hunt bugs", source: "claude" },
			{ name: "review", description: "Review a PR", source: "agents" },
		]);
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

	it("clicking backdrop with empty form closes immediately", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const overlay = screen.getByText("New Task").closest(".fixed");
		if (overlay) await userEvent.click(overlay);

		expect(onClose).toHaveBeenCalled();
	});

	it("clicking backdrop with filled form shows discard confirmation", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");

		const overlay = screen.getByText("New Task").closest(".fixed");
		if (overlay) await userEvent.click(overlay);

		expect(screen.getByText("Discard")).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("clicking inside the modal does not close it", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		// Click on the modal dialog itself (not the backdrop)
		await userEvent.click(screen.getByText("New Task"));

		expect(onClose).not.toHaveBeenCalled();
	});

	it("X close button with empty description closes immediately", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		await userEvent.click(screen.getByLabelText("Close"));

		expect(onClose).toHaveBeenCalled();
	});

	it("X close button with filled description shows inline discard confirmation", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.click(screen.getByLabelText("Close"));

		expect(screen.getByText("Discard")).toBeInTheDocument();
		expect(screen.getByText("Keep editing")).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("clicking Discard in confirmation closes the modal", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.click(screen.getByLabelText("Close"));
		await userEvent.click(screen.getByText("Discard"));

		expect(onClose).toHaveBeenCalled();
	});

	it("clicking Keep editing hides confirmation and stays open", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.click(screen.getByLabelText("Close"));
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

	it("Escape on discard confirmation dismisses it without closing", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.keyboard("{Escape}");

		expect(screen.getByText("Discard")).toBeInTheDocument();

		await userEvent.keyboard("{Escape}");

		expect(screen.queryByText("Discard")).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("Keep editing button receives focus when discard confirmation appears", async () => {
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "some text");
		await userEvent.click(screen.getByLabelText("Close"));

		const keepEditingBtn = screen.getByText("Keep editing");
		expect(document.activeElement).toBe(keepEditingBtn);
	});

	it("uploads dropped images and inserts the saved path", async () => {
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...") as HTMLTextAreaElement;
		const file = new File(["abc"], "drop.jpg", { type: "image/jpeg", lastModified: 1711111111111 });

		dispatchDrop(textarea.parentElement!, [file]);

		await waitFor(() => {
			expect(mockedApi.request.uploadFileBase64).toHaveBeenCalledWith({
				projectId: "p1",
				base64: "YWJj",
				filename: "drop.jpg",
				mimeType: "image/jpeg",
			});
		});
		await waitFor(() => {
			expect(textarea.value).toBe("/tmp/uploaded-drop.png\n");
		});
		expect(mockedApi.request.uploadImageBase64).not.toHaveBeenCalled();
	});

	it("uploads non-image drops and inserts the saved path", async () => {
		mockedApi.request.uploadFileBase64.mockResolvedValue({ path: "/tmp/uploaded-notes.txt" });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...") as HTMLTextAreaElement;
		const file = new File(["notes"], "notes.txt", { type: "text/plain", lastModified: 1712222222222 });

		dispatchDrop(textarea.parentElement!, [file]);

		await waitFor(() => {
			expect(mockedApi.request.uploadFileBase64).toHaveBeenCalledWith({
				projectId: "p1",
				base64: "bm90ZXM=",
				filename: "notes.txt",
				mimeType: "text/plain",
			});
		});
		await waitFor(() => {
			expect(textarea.value).toBe("/tmp/uploaded-notes.txt\n");
		});
	});

	const PASTED_TXT_PATH = "/home/user/.dev3.0/worktrees/proj/uploads/upload-1781612040314-24b3-pasted-text.txt";

	it("saves a large text paste to a .txt file and inserts its path", async () => {
		mockedApi.request.uploadFileBase64.mockResolvedValue({ path: PASTED_TXT_PATH });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...") as HTMLTextAreaElement;
		const bigText = "x".repeat(9000);
		const event = dispatchTextPaste(textarea, bigText);

		expect(event.defaultPrevented).toBe(true);
		await waitFor(() => {
			expect(mockedApi.request.uploadFileBase64).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "p1",
					filename: "pasted-text.txt",
					mimeType: "text/plain",
				}),
			);
		});
		await waitFor(() => {
			expect(textarea.value).toBe(`${PASTED_TXT_PATH}\n`);
		});
	});

	it("shows a removable file card for a pasted text attachment", async () => {
		mockedApi.request.uploadFileBase64.mockResolvedValue({ path: PASTED_TXT_PATH });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...") as HTMLTextAreaElement;
		dispatchTextPaste(textarea, "y".repeat(9000));

		const card = await screen.findByText("upload-1781612040314-24b3-pasted-text.txt");
		expect(card).toBeInTheDocument();

		await userEvent.click(screen.getByTitle("Remove file"));

		await waitFor(() => {
			expect(screen.queryByText("upload-1781612040314-24b3-pasted-text.txt")).not.toBeInTheDocument();
		});
		expect(textarea.value).toBe("");
	});

	it("lets a small text paste fall through without uploading", async () => {
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...") as HTMLTextAreaElement;
		const event = dispatchTextPaste(textarea, "short note");

		expect(event.defaultPrevented).toBe(false);
		expect(mockedApi.request.uploadFileBase64).not.toHaveBeenCalled();
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

	// ---- Current branch choice guardrail ----

	it("auto-fills branch when project is on a non-base branch", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "feat/login", isBaseBranch: false, isDirty: false, behindOrigin: 0 });
		renderModal();

		await waitFor(() => {
			expect(screen.getByText("feat/login")).toBeInTheDocument();
		});
	});

	it("asks whether to use the current branch or the base branch", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "feat/login", isBaseBranch: false, isDirty: false, behindOrigin: 0 });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Continue login work");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(screen.getByText("Start task from which branch?")).toBeInTheDocument();
		});
		expect(mockedApi.request.createTask).not.toHaveBeenCalled();
	});

	it("uses the current branch after explicit confirmation", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "feat/login", isBaseBranch: false, isDirty: true, behindOrigin: 0 });
		renderModal({ dispatch: vi.fn() });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Continue login work");
		await userEvent.click(screen.getByText("Save"));
		await userEvent.click(screen.getByText("Use current branch: feat/login"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "Continue login work",
				existingBranch: "feat/login",
			});
		});
	});

	it("shows a dirty repo warning in the confirmation dialog", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "feat/login", isBaseBranch: false, isDirty: true, behindOrigin: 0 });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Continue login work");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(screen.getByText("Main repo has uncommitted Git changes. Those uncommitted changes stay here and do not move into the new task.")).toBeInTheDocument();
		});
	});

	it("clarifies that base branch means the project base branch", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "feat/login", isBaseBranch: false, isDirty: false, behindOrigin: 0 });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Continue login work");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(screen.getByText("Here, base branch means the project base branch, using origin/main when available.")).toBeInTheDocument();
		});
		expect(screen.getByText("Use project base branch: main")).toBeInTheDocument();
	});

	it("keeps the base branch as default after explicit confirmation", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "feat/login", isBaseBranch: false, isDirty: false, behindOrigin: 0 });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "New task");
		await userEvent.click(screen.getByText("Save"));
		await userEvent.click(screen.getByText("Use project base branch: main"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "New task",
			});
		});
	});

	// ---- Scratch Task ----

	it("shows Scratch Task button when onCreateAndRun is provided", () => {
		renderModal({ onCreateAndRun: vi.fn() });
		expect(screen.getByText("Scratch Task")).toBeInTheDocument();
	});

	it("does not show Scratch Task button when onCreateAndRun is omitted", () => {
		renderModal();
		expect(screen.queryByText("Scratch Task")).not.toBeInTheDocument();
	});

	it("Scratch Task button is enabled with empty description", () => {
		renderModal({ onCreateAndRun: vi.fn() });
		const btn = screen.getByText("Scratch Task").closest("button");
		expect(btn).not.toBeDisabled();
	});

	it("Scratch Task click sends scratch:true and empty description, calls onCreateAndRun", async () => {
		const onCreateAndRun = vi.fn();
		const dispatch = vi.fn();
		renderModal({ onCreateAndRun, dispatch });

		await userEvent.click(screen.getByText("Scratch Task"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "",
				scratch: true,
			});
		});
		expect(dispatch).toHaveBeenCalledWith({ type: "addTask", task: mockTask });
		expect(onCreateAndRun).toHaveBeenCalledWith(mockTask);
	});

	it("Scratch Task ignores typed description text (backend generates placeholder)", async () => {
		const onCreateAndRun = vi.fn();
		renderModal({ onCreateAndRun });

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "irrelevant text user typed then clicked scratch");
		await userEvent.click(screen.getByText("Scratch Task"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "",
				scratch: true,
			});
		});
	});

	it("does not ask when project is already on the base branch", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false, behindOrigin: 0 });
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "New task");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "New task",
			});
		});
		expect(screen.queryByText("Start task from which branch?")).not.toBeInTheDocument();
	});

	it("does not ask after clearing the auto-filled branch", async () => {
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "feat/login", isBaseBranch: false, isDirty: false, behindOrigin: 0 });
		renderModal();

		await waitFor(() => {
			expect(screen.getByText("feat/login")).toBeInTheDocument();
		});

		const clearButton = screen.getByText("feat/login").parentElement?.querySelector("button");
		expect(clearButton).toBeTruthy();
		await userEvent.click(clearButton!);

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "New task");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({
				projectId: "p1",
				description: "New task",
			});
		});
		expect(screen.queryByText("Start task from which branch?")).not.toBeInTheDocument();
	});

	it("does not ask when current branch lookup fails", async () => {
		mockedApi.request.getProjectCurrentBranch.mockRejectedValue(new Error("fail"));
		renderModal();

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

	it("still asks on a fast Save click while branch lookup is in-flight", async () => {
		// Reproduce the race: user clicks Save before getProjectCurrentBranch
		// resolves. The closed-over `selectedBranch` is still null (auto-fill
		// hasn't committed yet); the confirmation must still fire instead of
		// silently creating from the base branch.
		let resolveBranch: (value: { branch: string | null; isBaseBranch: boolean; isDirty: boolean; behindOrigin: number }) => void = () => {};
		const branchPromise = new Promise<{ branch: string | null; isBaseBranch: boolean; isDirty: boolean; behindOrigin: number }>((resolve) => {
			resolveBranch = resolve;
		});
		mockedApi.request.getProjectCurrentBranch.mockReturnValue(branchPromise);
		renderModal();

		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Racey task");
		await userEvent.click(screen.getByText("Save"));

		// Now let the lookup complete with a non-base branch.
		resolveBranch({ branch: "feat/login", isBaseBranch: false, isDirty: false, behindOrigin: 0 });

		await waitFor(() => {
			expect(screen.getByText("Start task from which branch?")).toBeInTheDocument();
		});
		expect(mockedApi.request.createTask).not.toHaveBeenCalled();
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

	it("fetches fork branches into the visible dropdown instead of auto-selecting them", async () => {
		mockedApi.request.listBranches.mockResolvedValue([]);
		mockedApi.request.fetchBranches.mockResolvedValue([
			{ name: "feature/local-work", isRemote: false },
			{ name: "origin/main", isRemote: true },
			{ name: "sworgkh/fix/dev3-tmux-switch-glitch", isRemote: true },
		]);
		renderModal();

		await userEvent.click(screen.getByText("Use existing branch"));
		const input = screen.getByPlaceholderText("Type to search branches...");
		await userEvent.type(input, "sworgkh:fix/dev3-tmux-switch-glitch");
		await userEvent.click(screen.getByText("Fetch"));

		await waitFor(() => {
			expect(mockedApi.request.fetchBranches).toHaveBeenCalledWith({
				projectId: "p1",
				forkRef: "sworgkh:fix/dev3-tmux-switch-glitch",
			});
		});

		expect(screen.getByPlaceholderText("Type to search branches...")).toHaveValue("sworgkh/fix/dev3-tmux-switch-glitch");
		expect(screen.getByText("sworgkh/fix/dev3-tmux-switch-glitch")).toBeInTheDocument();

		await userEvent.click(screen.getByText("sworgkh/fix/dev3-tmux-switch-glitch"));
		expect(screen.queryByPlaceholderText("Type to search branches...")).not.toBeInTheDocument();
		expect(screen.getByText("sworgkh/fix/dev3-tmux-switch-glitch")).toBeInTheDocument();
	});
});

// ================================================================
// Inline label creation in the Create-Task modal
// ================================================================

describe("CreateTaskModal labels", () => {
	const labeledProject: Project = {
		...mockProject,
		labels: [
			{ id: "lbl-bug", name: "Bug", color: "#ef4444" },
			{ id: "lbl-feat", name: "Feature", color: "#84cc16" },
		],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.createTask.mockResolvedValue(mockTask);
		mockedApi.request.setTaskLabels.mockResolvedValue(mockTask);
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false, behindOrigin: 0 });
		mockedApi.request.listAgentSkills.mockResolvedValue([]);
	});

	it("shows the add-label affordance even when the project has no labels", () => {
		renderModal();
		expect(screen.getByTitle("+ Add Label")).toBeInTheDocument();
	});

	it("creates a new label inline and selects it on the task", async () => {
		const dispatch = vi.fn();
		mockedApi.request.createLabel.mockResolvedValue({ id: "lbl-new", name: "Urgent", color: "#3b82f6" });
		renderModal({ dispatch, project: labeledProject });

		await userEvent.click(screen.getByTitle("+ Add Label"));
		const input = screen.getByPlaceholderText("Label name");
		await userEvent.type(input, "Urgent{Enter}");

		await waitFor(() => {
			expect(mockedApi.request.createLabel).toHaveBeenCalledWith({ projectId: "p1", name: "Urgent" });
		});
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
			type: "updateProject",
			project: expect.objectContaining({
				labels: expect.arrayContaining([{ id: "lbl-new", name: "Urgent", color: "#3b82f6" }]),
			}),
		}));

		// The new label must be carried into the created task.
		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Do the thing");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(mockedApi.request.setTaskLabels).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				labelIds: ["lbl-new"],
			});
		});
	});

	it("does not create a duplicate when typing an existing label name", async () => {
		renderModal({ project: labeledProject });

		await userEvent.click(screen.getByTitle("+ Add Label"));
		const input = screen.getByPlaceholderText("Label name");
		await userEvent.type(input, "bug{Enter}");

		expect(mockedApi.request.createLabel).not.toHaveBeenCalled();

		// Existing label gets selected and passed through on create.
		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, "Do the thing");
		await userEvent.click(screen.getByText("Save"));

		await waitFor(() => {
			expect(mockedApi.request.setTaskLabels).toHaveBeenCalledWith({
				taskId: "t1",
				projectId: "p1",
				labelIds: ["lbl-bug"],
			});
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

describe("CreateTaskModal skill autocomplete", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.createTask.mockResolvedValue(mockTask);
		mockedApi.request.getProjectCurrentBranch.mockResolvedValue({ branch: "main", isBaseBranch: true, isDirty: false, behindOrigin: 0 });
		mockedApi.request.listAgentSkills.mockResolvedValue([
			{ name: "dev3", description: "Manage dev3 tasks", source: "claude" },
			{ name: "dev3-bug-hunter", description: "Hunt bugs", source: "claude" },
			{ name: "review", description: "Review a PR", source: "agents" },
		]);
	});

	async function typeInDescription(text: string) {
		const textarea = screen.getByPlaceholderText("Describe what needs to be done...");
		await userEvent.type(textarea, text);
		return textarea as HTMLTextAreaElement;
	}

	it("shows the dropdown when typing /", async () => {
		renderModal();
		await typeInDescription("/");
		await waitFor(() => {
			expect(screen.getByRole("listbox")).toBeInTheDocument();
		});
		expect(screen.getByText("/dev3")).toBeInTheDocument();
		expect(screen.getByText("/review")).toBeInTheDocument();
	});

	it("filters skills by the typed prefix", async () => {
		renderModal();
		await typeInDescription("/d");
		await waitFor(() => {
			expect(screen.getByText("/dev3")).toBeInTheDocument();
		});
		expect(screen.queryByText("/review")).not.toBeInTheDocument();
	});

	it("inserts the selected skill on Enter", async () => {
		renderModal();
		const textarea = await typeInDescription("/dev");
		await waitFor(() => {
			expect(screen.getByRole("listbox")).toBeInTheDocument();
		});
		await userEvent.keyboard("{Enter}");
		await waitFor(() => {
			expect(textarea.value).toBe("/dev3 ");
		});
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("inserts the arrow-selected skill", async () => {
		renderModal();
		const textarea = await typeInDescription("/dev");
		await waitFor(() => {
			expect(screen.getByRole("listbox")).toBeInTheDocument();
		});
		await userEvent.keyboard("{ArrowDown}{Enter}");
		await waitFor(() => {
			expect(textarea.value).toBe("/dev3-bug-hunter ");
		});
	});

	it("inserts a skill on click", async () => {
		renderModal();
		const textarea = await typeInDescription("/rev");
		await waitFor(() => {
			expect(screen.getByText("/review")).toBeInTheDocument();
		});
		await userEvent.click(screen.getByText("/review"));
		await waitFor(() => {
			expect(textarea.value).toBe("/review ");
		});
	});

	it("Escape closes the dropdown but keeps the modal open", async () => {
		const onClose = vi.fn();
		renderModal({ onClose });
		await typeInDescription("/d");
		await waitFor(() => {
			expect(screen.getByRole("listbox")).toBeInTheDocument();
		});
		await userEvent.keyboard("{Escape}");
		await waitFor(() => {
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText("New Task")).toBeInTheDocument();
	});

	it("does not open the dropdown for a slash inside a path", async () => {
		renderModal();
		await typeInDescription("fix uploaded-images/dev3");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("hides the dropdown when nothing matches", async () => {
		renderModal();
		await typeInDescription("/zzz");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});
});

describe("CreateTaskModal — virtual (Operations) project", () => {
	const vproject: Project = { ...mockProject, kind: "virtual", path: "/home/user/.dev3.0/ops/operations" };

	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.request.createTask.mockResolvedValue(mockTask);
	});

	it("shows the working-folder selector, not the branch selector", () => {
		renderModal({ project: vproject });
		expect(screen.getByText("Managed temp folder (automatic)")).toBeInTheDocument();
		expect(screen.queryByText("Use existing branch")).not.toBeInTheDocument();
	});

	it("creates a virtual task with the managed folder (no opsWorkDir)", async () => {
		renderModal({ project: vproject });
		await userEvent.type(screen.getByPlaceholderText("Describe what needs to be done..."), "Backup prod");
		await userEvent.click(screen.getByText("Save"));
		await waitFor(() => {
			expect(mockedApi.request.createTask).toHaveBeenCalledWith({ projectId: "p1", description: "Backup prod" });
		});
	});
});
