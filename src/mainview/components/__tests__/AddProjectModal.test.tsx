import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AddProjectModal from "../AddProjectModal";
import { I18nProvider } from "../../i18n";
import type { AppAction } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			addProject: vi.fn(),
			addVirtualProject: vi.fn(),
			cloneAndAddProject: vi.fn(),
			initAndAddProject: vi.fn(),
			getGlobalSettings: vi.fn(() =>
				Promise.resolve({
					defaultAgentId: "builtin-claude",
					defaultConfigId: "claude-default",
					taskSortOrder: "oldest-first",
					updateChannel: "stable",
				}),
			),
			saveGlobalSettings: vi.fn(),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
		},
	},
}));

vi.mock("../../confirm", () => ({ confirm: vi.fn() }));

vi.mock("../../toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("../../folder-picker", () => ({
	openFolderPicker: vi.fn(),
	openFolderPickerMulti: vi.fn(),
}));

import { api } from "../../rpc";
import { openFolderPicker, openFolderPickerMulti } from "../../folder-picker";
import { confirm } from "../../confirm";
import { toast } from "../../toast";

const mockedApi = vi.mocked(api, true);
const mockedOpenFolderPicker = vi.mocked(openFolderPicker);
const mockedOpenFolderPickerMulti = vi.mocked(openFolderPickerMulti);
const mockedConfirm = vi.mocked(confirm);

const gitInitOffer = { path: "/tmp/demo", mode: "init" as const, placeholder: "create" as const, existingEntries: 2 };

function renderModal(
	dispatch?: React.Dispatch<AppAction>,
	onClose?: () => void,
) {
	return render(
		<I18nProvider>
			<AddProjectModal
				dispatch={dispatch ?? vi.fn()}
				onClose={onClose ?? vi.fn()}
			/>
		</I18nProvider>,
	);
}

const mockProject = {
	id: "p-new",
	name: "my-repo",
	path: "/base/my-repo",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

describe("AddProjectModal", () => {
	it("traps focus inside the dialog on open", () => {
		renderModal();
		const dialog = screen.getByRole("dialog");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders with three tabs", () => {
		renderModal();
		expect(screen.getByText("Local Folder")).toBeInTheDocument();
		expect(screen.getByText("Clone from URL")).toBeInTheDocument();
		expect(screen.getByText("New")).toBeInTheDocument();
	});

	it("init flow: picks a folder, runs initAndAddProject, dispatches addProject", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();
		mockedOpenFolderPicker.mockResolvedValue("/tmp/fresh");
		mockedApi.request.initAndAddProject.mockResolvedValue({ ok: true, project: mockProject } as any);

		renderModal(dispatch, onClose);
		await act(async () => { await user.click(screen.getByText("New")); });
		await act(async () => { await user.click(screen.getByText("Pick folder...")); });

		expect(mockedOpenFolderPicker).toHaveBeenCalledWith(expect.objectContaining({ allowCreateFolder: true }));
		// No `name`: the backend derives it, because only it knows how paths are
		// spelled on the machine that owns the repo (a Windows drive over remote).
		expect(mockedApi.request.initAndAddProject).toHaveBeenCalledWith({ path: "/tmp/fresh" });
		expect(dispatch).toHaveBeenCalledWith({ type: "addProject", project: mockProject });
		expect(onClose).toHaveBeenCalled();
	});

	it("init flow: surfaces error from initAndAddProject", async () => {
		const user = userEvent.setup();
		mockedOpenFolderPicker.mockResolvedValue("/tmp/messy");
		mockedApi.request.initAndAddProject.mockResolvedValue({
			ok: false,
			error: "Folder is not empty and not a git repository.",
		} as any);

		renderModal();
		await act(async () => { await user.click(screen.getByText("New")); });
		await act(async () => { await user.click(screen.getByText("Pick folder...")); });

		expect(screen.getByText(/not empty/i)).toBeInTheDocument();
	});

	describe("non-empty folder without git (issue #1976)", () => {
		it("Local Folder: confirms, explains untracked files, then initializes in place", async () => {
			const user = userEvent.setup();
			const dispatch = vi.fn();
			const onClose = vi.fn();
			mockedOpenFolderPickerMulti.mockResolvedValue(["/tmp/demo"]);
			mockedApi.request.addProject.mockResolvedValue({ ok: false, error: "Selected folder is not a git repository", gitInit: gitInitOffer } as any);
			mockedConfirm.mockResolvedValue(true);
			mockedApi.request.initAndAddProject.mockResolvedValue({ ok: true, project: mockProject, gitInit: gitInitOffer } as any);

			renderModal(dispatch, onClose);
			await act(async () => { await user.click(screen.getByText("Browse...")); });

			const asked = mockedConfirm.mock.calls[0][0];
			expect(asked.title).toBe("Initialize Git in this folder?");
			expect(asked.confirmLabel).toBe("Initialize Git and add");
			expect(asked.message).toContain("/tmp/demo");
			expect(asked.message).toContain("only .dev3/README.md");
			expect(asked.message).toContain("The 2 items already in this folder are not changed, staged, or committed.");
			expect(asked.message).toContain("task worktrees will not include them");
			expect(mockedApi.request.initAndAddProject).toHaveBeenCalledWith({ path: "/tmp/demo", initNonEmpty: true });
			expect(dispatch).toHaveBeenCalledWith({ type: "addProject", project: mockProject });
			expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining("Existing files stay untracked"), expect.anything());
			expect(onClose).toHaveBeenCalled();
		});

		it("Local Folder: declining changes nothing and keeps the dialog open", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			mockedOpenFolderPickerMulti.mockResolvedValue(["/tmp/demo"]);
			mockedApi.request.addProject.mockResolvedValue({ ok: false, error: "Selected folder is not a git repository", gitInit: gitInitOffer } as any);
			mockedConfirm.mockResolvedValue(false);

			renderModal(vi.fn(), onClose);
			await act(async () => { await user.click(screen.getByText("Browse...")); });

			expect(mockedApi.request.initAndAddProject).not.toHaveBeenCalled();
			expect(screen.getByText(/Not added\. The folder was left unchanged\./)).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});

		it("Escape answers the pending confirmation instead of closing the dialog under it", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			mockedOpenFolderPickerMulti.mockResolvedValue(["/tmp/demo"]);
			mockedApi.request.addProject.mockResolvedValue({ ok: false, error: "Selected folder is not a git repository", gitInit: gitInitOffer } as any);
			let signal: AbortSignal | undefined;
			mockedConfirm.mockImplementation((opts) => new Promise<boolean>((resolve) => {
				signal = opts.signal;
				opts.signal?.addEventListener("abort", () => resolve(false));
			}) as any);

			renderModal(vi.fn(), onClose);
			await act(async () => { await user.click(screen.getByText("Browse...")); });
			await act(async () => { await user.keyboard("{Escape}"); });

			expect(signal?.aborted).toBe(true);
			expect(onClose).not.toHaveBeenCalled();
			expect(mockedApi.request.initAndAddProject).not.toHaveBeenCalled();
			expect(screen.getByText(/Not added\. The folder was left unchanged\./)).toBeInTheDocument();

			await act(async () => { await user.keyboard("{Escape}"); });
			expect(onClose).toHaveBeenCalled();
		});

		it("Local Folder: a plain non-repo error without an offer never asks", async () => {
			const user = userEvent.setup();
			mockedOpenFolderPickerMulti.mockResolvedValue(["/tmp/odd"]);
			mockedApi.request.addProject.mockResolvedValue({ ok: false, error: "Selected folder is not a git repository" } as any);

			renderModal();
			await act(async () => { await user.click(screen.getByText("Browse...")); });

			expect(mockedConfirm).not.toHaveBeenCalled();
			expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
		});

		it("New: confirms, initializes, and shows the failure when git refuses", async () => {
			const user = userEvent.setup();
			mockedOpenFolderPicker.mockResolvedValue("/tmp/demo");
			mockedApi.request.initAndAddProject
				.mockResolvedValueOnce({ ok: false, error: "Folder is not empty and not a git repository.", gitInit: gitInitOffer } as any)
				.mockResolvedValueOnce({ ok: false, error: "git init failed: Permission denied" } as any);
			mockedConfirm.mockResolvedValue(true);

			renderModal();
			await act(async () => { await user.click(screen.getByText("New")); });
			await act(async () => { await user.click(screen.getByText("Pick folder...")); });

			expect(mockedApi.request.initAndAddProject).toHaveBeenNthCalledWith(1, { path: "/tmp/demo" });
			expect(mockedApi.request.initAndAddProject).toHaveBeenNthCalledWith(2, { path: "/tmp/demo", initNonEmpty: true });
			expect(screen.getByText("git init failed: Permission denied")).toBeInTheDocument();
		});

		it("New: a commit-less repo is offered a first commit, staged work called out", async () => {
			const user = userEvent.setup();
			mockedOpenFolderPicker.mockResolvedValue("/tmp/demo");
			mockedApi.request.initAndAddProject.mockResolvedValueOnce({
				ok: false,
				error: "This Git repository has no commits yet",
				gitInit: { ...gitInitOffer, mode: "first-commit", placeholder: "keep", existingEntries: 1 },
			} as any);
			mockedConfirm.mockResolvedValue(false);

			renderModal();
			await act(async () => { await user.click(screen.getByText("New")); });
			await act(async () => { await user.click(screen.getByText("Pick folder...")); });

			const asked = mockedConfirm.mock.calls[0][0];
			expect(asked.confirmLabel).toBe("Make first commit and add");
			expect(asked.message).toContain("make an empty first commit");
			expect(asked.message).toContain("anything you staged stays staged");
			expect(asked.message).not.toContain("untracked");
			expect(mockedApi.request.initAndAddProject).toHaveBeenCalledTimes(1);
		});
	});

	it("defaults to Local Folder tab with Browse button", () => {
		renderModal();
		expect(screen.getByText("Browse...")).toBeInTheDocument();
	});

	it("switches to Clone tab and shows URL input", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.click(screen.getByText("Clone from URL"));
		expect(screen.getByPlaceholderText("https://github.com/user/repo.git")).toBeInTheDocument();
	});

	it("opens folder picker and calls addProject from Local tab", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();

		mockedOpenFolderPickerMulti.mockResolvedValue(["/new/path"]);
		mockedApi.request.addProject.mockResolvedValue({
			ok: true as const,
			project: { ...mockProject, path: "/new/path", name: "path" },
		});

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Browse..."));

		expect(mockedOpenFolderPickerMulti).toHaveBeenCalled();
		expect(mockedApi.request.addProject).toHaveBeenCalledWith({ path: "/new/path" });
		expect(dispatch).toHaveBeenCalledWith({
			type: "addProject",
			project: expect.objectContaining({ path: "/new/path" }),
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("opens folder picker and adds multiple projects at once", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();

		mockedOpenFolderPickerMulti.mockResolvedValue(["/path/repo-a", "/path/repo-b"]);
		mockedApi.request.addProject
			.mockResolvedValueOnce({ ok: true as const, project: { ...mockProject, path: "/path/repo-a", name: "repo-a" } })
			.mockResolvedValueOnce({ ok: true as const, project: { ...mockProject, path: "/path/repo-b", name: "repo-b" } });

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Browse..."));

		expect(mockedApi.request.addProject).toHaveBeenCalledTimes(2);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(onClose).toHaveBeenCalled();
	});

	it("does nothing when folder picker is cancelled", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();

		mockedOpenFolderPickerMulti.mockResolvedValue(null);

		renderModal(dispatch);
		await user.click(screen.getByText("Browse..."));

		expect(mockedApi.request.addProject).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("Clone button is disabled when URL is empty", async () => {
		const user = userEvent.setup();
		renderModal();
		await user.click(screen.getByText("Clone from URL"));

		const cloneBtn = screen.getByText("Clone");
		expect(cloneBtn).toBeDisabled();
	});

	it("calls cloneAndAddProject on Clone tab submit", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();

		// Return settings with a saved base directory
		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskSortOrder: "oldest-first",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});

		mockedApi.request.cloneAndAddProject.mockResolvedValue({
			ok: true as const,
			project: mockProject,
		});

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Clone from URL"));

		const urlInput = screen.getByPlaceholderText("https://github.com/user/repo.git");
		await user.type(urlInput, "https://github.com/user/my-repo.git");
		await user.click(screen.getByText("Clone"));

		expect(mockedApi.request.cloneAndAddProject).toHaveBeenCalledWith({
			url: "https://github.com/user/my-repo.git",
			baseDir: "/base",
			repoName: undefined,
			progressId: expect.any(String),
		});
		expect(dispatch).toHaveBeenCalledWith({
			type: "addProject",
			project: expect.objectContaining({ id: "p-new" }),
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("shows error when clone fails", async () => {
		const user = userEvent.setup();

		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskSortOrder: "oldest-first",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});

		mockedApi.request.cloneAndAddProject.mockResolvedValue({
			ok: false as const,
			error: "fatal: repo not found",
		});

		renderModal();
		await user.click(screen.getByText("Clone from URL"));
		await user.type(
			screen.getByPlaceholderText("https://github.com/user/repo.git"),
			"https://github.com/bad/url.git",
		);
		await user.click(screen.getByText("Clone"));

		expect(screen.getByText("fatal: repo not found")).toBeInTheDocument();
	});

	it("shows live clone output pushed via rpc:cloneProgress while cloning", async () => {
		const user = userEvent.setup();

		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskSortOrder: "oldest-first",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});
		let resolveClone!: (v: any) => void;
		mockedApi.request.cloneAndAddProject.mockImplementation(
			() => new Promise((resolve) => { resolveClone = resolve; }),
		);

		renderModal();
		await user.click(screen.getByText("Clone from URL"));
		await user.type(
			screen.getByPlaceholderText("https://github.com/user/repo.git"),
			"https://github.com/user/my-repo.git",
		);
		await user.click(screen.getByText("Clone"));

		// Placeholder until the first progress push arrives
		expect(screen.getByRole("status")).toHaveTextContent("Cloning...");

		const progressId = vi.mocked(mockedApi.request.cloneAndAddProject).mock.calls[0][0].progressId;
		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:cloneProgress", {
				detail: { progressId, lines: ["Cloning into 'my-repo'...", "Receiving objects: 42% (10/24)"] },
			}));
		});
		expect(screen.getByText("Receiving objects: 42% (10/24)")).toBeInTheDocument();

		await act(async () => { resolveClone({ ok: true, project: mockProject }); });
	});

	it("ignores rpc:cloneProgress events with a foreign progressId", async () => {
		const user = userEvent.setup();

		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskSortOrder: "oldest-first",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});
		let resolveClone!: (v: any) => void;
		mockedApi.request.cloneAndAddProject.mockImplementation(
			() => new Promise((resolve) => { resolveClone = resolve; }),
		);

		renderModal();
		await user.click(screen.getByText("Clone from URL"));
		await user.type(
			screen.getByPlaceholderText("https://github.com/user/repo.git"),
			"https://github.com/user/my-repo.git",
		);
		await user.click(screen.getByText("Clone"));

		act(() => {
			window.dispatchEvent(new CustomEvent("rpc:cloneProgress", {
				detail: { progressId: "someone-else", lines: ["should not appear"] },
			}));
		});
		expect(screen.queryByText("should not appear")).not.toBeInTheDocument();

		await act(async () => { resolveClone({ ok: true, project: mockProject }); });
	});

	it("calls onClose when Cancel is clicked", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();

		renderModal(vi.fn(), onClose);
		await user.click(screen.getByText("Cancel"));

		expect(onClose).toHaveBeenCalled();
	});

	it("Escape closes the modal", async () => {
		const onClose = vi.fn();
		renderModal(vi.fn(), onClose);
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("Cmd+Enter submits clone when URL and base dir are set", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();

		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskSortOrder: "oldest-first",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});
		mockedApi.request.cloneAndAddProject.mockResolvedValue({
			ok: true as const,
			project: mockProject,
		});

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Clone from URL"));

		const urlInput = screen.getByPlaceholderText("https://github.com/user/repo.git");
		await user.type(urlInput, "https://github.com/user/my-repo.git");
		await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

		await vi.waitFor(() => {
			expect(mockedApi.request.cloneAndAddProject).toHaveBeenCalled();
		});
	});

	it("Browse button is disabled while addProject is pending", async () => {
		const user = userEvent.setup();
		let resolveAddProject!: (v: any) => void;
		mockedOpenFolderPickerMulti.mockResolvedValue(["/new/path"]);
		mockedApi.request.addProject.mockImplementation(
			() => new Promise((resolve) => { resolveAddProject = resolve; }),
		);

		renderModal();
		await user.click(screen.getByText("Browse..."));

		// After folder picker resolves but addProject is still pending
		const btn = screen.getByRole("button", { name: "Adding..." });
		expect(btn).toBeDisabled();

		// Resolve addProject
		await act(async () => {
			resolveAddProject({ ok: true, project: { ...mockProject, path: "/new/path" } });
		});
		await vi.waitFor(() => {
			expect(screen.getByText("Browse...")).toBeInTheDocument();
		});
	});

	it("Ctrl+Enter submits clone (Linux/Windows)", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();

		mockedApi.request.getGlobalSettings.mockResolvedValue({
			defaultAgentId: "builtin-claude",
			defaultConfigId: "claude-default",
			taskSortOrder: "oldest-first",
			updateChannel: "stable",
			cloneBaseDirectory: "/base",
		});
		mockedApi.request.cloneAndAddProject.mockResolvedValue({
			ok: true as const,
			project: mockProject,
		});

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Clone from URL"));

		const urlInput = screen.getByPlaceholderText("https://github.com/user/repo.git");
		await user.type(urlInput, "https://github.com/user/my-repo.git");
		await userEvent.keyboard("{Control>}{Enter}{/Control}");

		await vi.waitFor(() => {
			expect(mockedApi.request.cloneAndAddProject).toHaveBeenCalled();
		});
	});

	it("Operations toggle: creates a virtual board via addVirtualProject", async () => {
		const user = userEvent.setup();
		const dispatch = vi.fn();
		const onClose = vi.fn();
		mockedApi.request.addVirtualProject.mockResolvedValue({ ok: true, project: { ...mockProject, kind: "virtual" } } as any);

		renderModal(dispatch, onClose);
		await user.click(screen.getByText("Operations"));
		await user.type(screen.getByPlaceholderText("Operations"), "Mail triage");
		await user.click(screen.getByText("Create board"));

		expect(mockedApi.request.addVirtualProject).toHaveBeenCalledWith({ name: "Mail triage" });
		expect(dispatch).toHaveBeenCalledWith({ type: "addProject", project: expect.objectContaining({ kind: "virtual" }) });
		expect(onClose).toHaveBeenCalled();
	});

	it("Operations toggle: blank name defaults to 'Operations'", async () => {
		const user = userEvent.setup();
		mockedApi.request.addVirtualProject.mockResolvedValue({ ok: true, project: mockProject } as any);

		renderModal();
		await user.click(screen.getByText("Operations"));
		await user.click(screen.getByText("Create board"));

		expect(mockedApi.request.addVirtualProject).toHaveBeenCalledWith({ name: "Operations" });
	});

	// Blast-radius copy (bible §10). Two lines only, and the same two on every git
	// tab: a wall of reassurance reads as a warning, which is the opposite of the point.
	describe("blast-radius copy", () => {
		const baseClaim = /Tasks start from this project's base branch/;
		const branchClaim = /own branch in its own worktree/;

		it("states both consequences on every git tab", async () => {
			const user = userEvent.setup();
			renderModal();

			expect(screen.getByText(baseClaim)).toBeInTheDocument();
			expect(screen.getByText(branchClaim)).toBeInTheDocument();

			await user.click(screen.getByText("Clone from URL"));
			expect(screen.getByText(baseClaim)).toBeInTheDocument();
			expect(screen.getByText(branchClaim)).toBeInTheDocument();

			await user.click(screen.getByText("New"));
			expect(screen.getByText(baseClaim)).toBeInTheDocument();
			expect(screen.getByText(branchClaim)).toBeInTheDocument();
		});

		it("is absent on the Operations board, which has no repository at all", async () => {
			const user = userEvent.setup();
			renderModal();
			await user.click(screen.getByText("Operations"));

			expect(screen.queryByText(baseClaim)).not.toBeInTheDocument();
			expect(screen.queryByText(branchClaim)).not.toBeInTheDocument();
		});
	});

	describe("auto-configure switch", () => {
		it("is off by default and adds projects without it", async () => {
			const user = userEvent.setup();
			mockedOpenFolderPickerMulti.mockResolvedValue(["/work/app"]);
			mockedApi.request.addProject.mockResolvedValue({ ok: true as const, project: mockProject });
			renderModal();

			expect(screen.getByRole("switch", { name: "Auto-configure" })).toHaveAttribute("aria-checked", "false");
			await user.click(screen.getByText("Browse..."));

			expect(mockedApi.request.addProject).toHaveBeenCalledWith({ path: "/work/app" });
		});

		it("on: asks for auto-configure, remembers the choice, and announces what was saved", async () => {
			const user = userEvent.setup();
			const { toast } = await import("../../toast");
			const success = vi.spyOn(toast, "success");
			mockedOpenFolderPickerMulti.mockResolvedValue(["/work/app"]);
			mockedApi.request.addProject.mockResolvedValue({
				ok: true as const,
				project: mockProject,
				autoConfigured: { written: ["setupScript", "devScript"] },
			});
			renderModal();

			await user.click(screen.getByRole("switch", { name: "Auto-configure" }));
			expect(mockedApi.request.saveGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({ autoConfigureNewProjects: true }));
			await user.click(screen.getByText("Browse..."));

			expect(mockedApi.request.addProject).toHaveBeenCalledWith({ path: "/work/app", autoConfigure: true });
			expect(success).toHaveBeenCalledWith(
				"my-repo: saved to .dev3/config.local.json: setup script, dev script. Edit in Project Settings.",
				expect.anything(),
			);
		});

		it("says so when the project was already configured", async () => {
			const user = userEvent.setup();
			const { toast } = await import("../../toast");
			const info = vi.spyOn(toast, "info");
			mockedOpenFolderPickerMulti.mockResolvedValue(["/work/app"]);
			mockedApi.request.addProject.mockResolvedValue({
				ok: true as const,
				project: mockProject,
				autoConfigured: { written: [], existingConfig: true },
			});
			renderModal();

			await user.click(screen.getByRole("switch", { name: "Auto-configure" }));
			await user.click(screen.getByText("Browse..."));

			expect(info).toHaveBeenCalledWith("my-repo is already configured, so auto-configure left it as is.", expect.anything());
		});

		it("reports a failure as an error, not as nothing found", async () => {
			const user = userEvent.setup();
			const { toast } = await import("../../toast");
			const error = vi.spyOn(toast, "error");
			const info = vi.spyOn(toast, "info");
			mockedOpenFolderPickerMulti.mockResolvedValue(["/work/app"]);
			mockedApi.request.addProject.mockResolvedValue({
				ok: true as const,
				project: mockProject,
				autoConfigured: { written: [], failed: true },
			});
			renderModal();

			await user.click(screen.getByRole("switch", { name: "Auto-configure" }));
			await user.click(screen.getByText("Browse..."));

			expect(error).toHaveBeenCalledWith("my-repo: could not save auto-configured settings.", expect.anything());
			expect(info).not.toHaveBeenCalled();
		});

		it("starts on when the user left it on last time", async () => {
			mockedApi.request.getGlobalSettings.mockResolvedValueOnce({
				defaultAgentId: "builtin-claude",
				defaultConfigId: "claude-default",
				taskSortOrder: "oldest-first",
				updateChannel: "stable",
				autoConfigureNewProjects: true,
			} as Awaited<ReturnType<typeof api.request.getGlobalSettings>>);
			renderModal();

			expect(await screen.findByRole("switch", { name: "Auto-configure", checked: true })).toBeInTheDocument();
		});

		it("keeps a click made before the stored setting arrives", async () => {
			const user = userEvent.setup();
			let resolveSettings!: (value: Awaited<ReturnType<typeof api.request.getGlobalSettings>>) => void;
			mockedApi.request.getGlobalSettings.mockImplementationOnce(() => new Promise((resolve) => { resolveSettings = resolve; }));
			renderModal();

			await user.click(screen.getByRole("switch", { name: "Auto-configure" }));
			await act(async () => {
				resolveSettings({
					defaultAgentId: "builtin-claude",
					defaultConfigId: "claude-default",
					taskSortOrder: "oldest-first",
					updateChannel: "stable",
				} as Awaited<ReturnType<typeof api.request.getGlobalSettings>>);
			});

			expect(screen.getByRole("switch", { name: "Auto-configure", checked: true })).toBeInTheDocument();
		});

		it("sits below the tab strip, inside the Local and Clone panes", async () => {
			const user = userEvent.setup();
			renderModal();
			const tabs = screen.getByText("Local Folder").parentElement!;

			for (const tab of ["Local Folder", "Clone from URL"]) {
				await user.click(screen.getByText(tab));
				const toggle = screen.getByRole("switch", { name: "Auto-configure" });
				expect(tabs.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			}
		});

		it("is hidden on the New tab, where there is nothing to detect", async () => {
			const user = userEvent.setup();
			renderModal();
			await user.click(screen.getByText("New"));

			expect(screen.queryByRole("switch", { name: "Auto-configure" })).not.toBeInTheDocument();
		});
	});
});
