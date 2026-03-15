import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectSettings from "../ProjectSettings";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			createLabel: vi.fn(),
			updateLabel: vi.fn(),
			deleteLabel: vi.fn(),
			detectClonePaths: vi.fn().mockResolvedValue([]),
			getProjectConfigs: vi.fn().mockResolvedValue({ repo: {}, local: {}, app: {} }),
			getProjectConfigFiles: vi.fn().mockResolvedValue({ hasRepoConfig: false, hasLocalConfig: false }),
			updateProjectSettings: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test Project", path: "/tmp/test", defaultBaseBranch: "main", setupScript: "", devScript: "", cleanupScript: "", createdAt: "" }),
			saveRepoConfig: vi.fn().mockResolvedValue(undefined),
			saveLocalConfig: vi.fn().mockResolvedValue(undefined),
			getProjects: vi.fn().mockResolvedValue([]),
			getAgents: vi.fn().mockResolvedValue([]),
		},
	},
}));

const mockProject: Project = {
	id: "proj-1",
	name: "Test Project",
	path: "/tmp/test",
	defaultBaseBranch: "main",
	setupScript: "bun install",
	devScript: "bun dev",
	cleanupScript: "rm -rf dist",
	labels: [],
	createdAt: new Date().toISOString(),
};

const mockTasks: Task[] = [];

const mockTaskWithWorktree: Task = {
	id: "task-1",
	seq: 1,
	projectId: "proj-1",
	title: "Test task",
	description: "Test description",
	status: "in-progress",
	baseBranch: "main",
	worktreePath: "/tmp/worktree-1",
	branchName: "feat/test",
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

async function renderProjectSettings(project: Project = mockProject, configOverrides: Partial<Project> = {}, tasks: Task[] = mockTasks) {
	const mergedProject = { ...project, ...configOverrides };
	const dispatch = vi.fn() as unknown as React.Dispatch<AppAction>;
	const navigate = vi.fn() as (route: Route) => void;
	let result: ReturnType<typeof render>;
	await act(async () => {
		result = render(
			<I18nProvider>
				<ProjectSettings
					projectId={mergedProject.id}
					projects={[mergedProject]}
					tasks={tasks}
					dispatch={dispatch}
					navigate={navigate}
				/>
			</I18nProvider>,
		);
	});
	return result!;
}

/** Navigate to the Project Config tab (not the default). */
async function goToProjectTab() {
	const user = userEvent.setup();
	await user.click(screen.getByText("Project Config"));
}

describe("ProjectSettings", () => {
	describe("tab navigation", () => {
		it("renders all three tabs", async () => {
			await renderProjectSettings();
			expect(screen.getByText("Board")).toBeInTheDocument();
			expect(screen.getByText("Project Config")).toBeInTheDocument();
			expect(screen.getByText("Worktree Config")).toBeInTheDocument();
		});

		it("shows Board tab by default", async () => {
			await renderProjectSettings();
			expect(screen.getByText(/Board layout/i)).toBeInTheDocument();
		});

		it("switches to project tab on click", async () => {
			const user = userEvent.setup();
			await renderProjectSettings();
			await user.click(screen.getByText("Project Config"));
			expect(screen.getByText(/Default settings for all tasks/i)).toBeInTheDocument();
		});

		it("switches to worktree tab on click", async () => {
			const user = userEvent.setup();
			await renderProjectSettings();
			await user.click(screen.getByText("Worktree Config"));
			expect(screen.getByText(/gear icon/i)).toBeInTheDocument();
		});
	});

	describe("project config form (app-level)", () => {
		it("populates form from project settings", async () => {
			await renderProjectSettings(mockProject, {
				setupScript: "bun install",
				defaultBaseBranch: "develop",
			});
			await goToProjectTab();

			await vi.waitFor(() => {
				expect(screen.getByDisplayValue("bun install")).toBeInTheDocument();
				expect(screen.getByDisplayValue("develop")).toBeInTheDocument();
			});
		});

		it("renders the configured default diff comparison mode", async () => {
			await renderProjectSettings(mockProject, {
				defaultCompareRefMode: "local",
			});

			await vi.waitFor(() => {
				expect(screen.getByDisplayValue("Local base branch")).toBeInTheDocument();
			});
		});

		it("setup script textarea has autocapitalize off", async () => {
			await renderProjectSettings(mockProject, { setupScript: "bun install" });
			await goToProjectTab();
			await vi.waitFor(() => {
				const textarea = screen.getByDisplayValue("bun install");
				expect(textarea).toHaveAttribute("autocapitalize", "off");
				expect(textarea).toHaveAttribute("autocorrect", "off");
				expect(textarea.getAttribute("spellcheck")).toBe("false");
			});
		});
	});

	describe("clone paths section", () => {
		it("renders the clone paths section", async () => {
			await renderProjectSettings();
			await goToProjectTab();
			expect(screen.getByText("Clone Paths (Copy-on-Write)")).toBeInTheDocument();
		});

		it("renders existing clone paths from config", async () => {
			await renderProjectSettings(mockProject, {
				clonePaths: ["node_modules", ".venv"],
			});
			await goToProjectTab();
			await vi.waitFor(() => {
				expect(screen.getByDisplayValue("node_modules")).toBeInTheDocument();
				expect(screen.getByDisplayValue(".venv")).toBeInTheDocument();
			});
		});

		it("renders auto-detect button", async () => {
			await renderProjectSettings(mockProject, { clonePaths: ["node_modules"] });
			await goToProjectTab();
			expect(screen.getByText("Auto-detect")).toBeInTheDocument();
		});
	});

	describe("peer review toggle", () => {
		it("toggle is on by default (peerReviewEnabled undefined)", async () => {
			await renderProjectSettings();
			await goToProjectTab();
			const toggle = screen.getByRole("switch", { name: /peer review column/i });
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});

		it("toggle reflects peerReviewEnabled: false from config", async () => {
			await renderProjectSettings(mockProject, { peerReviewEnabled: false });
			await goToProjectTab();
			await vi.waitFor(() => {
				const toggle = screen.getByRole("switch", { name: /peer review column/i });
				expect(toggle).toHaveAttribute("aria-checked", "false");
			});
		});

		it("clicking toggle flips state", async () => {
			const user = userEvent.setup();
			await renderProjectSettings();
			await goToProjectTab();
			const toggle = screen.getByRole("switch", { name: /peer review column/i });
			expect(toggle).toHaveAttribute("aria-checked", "true");
			await user.click(toggle);
			expect(toggle).toHaveAttribute("aria-checked", "false");
		});
	});

	describe("floating save banner", () => {
		it("shows unsaved changes banner when config is modified", async () => {
			const user = userEvent.setup();
			await renderProjectSettings(mockProject, { setupScript: "original" });
			await goToProjectTab();

			// Modify the setup script
			const textarea = screen.getByDisplayValue("original");
			await user.clear(textarea);
			await user.type(textarea, "changed");

			expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
			expect(screen.getByText("Save")).toBeInTheDocument();
		});

		it("calls updateProjectSettings when Save is clicked in banner", async () => {
			const { api } = await import("../../rpc");
			const mockSave = api.request.updateProjectSettings as ReturnType<typeof vi.fn>;


			const user = userEvent.setup();
			await renderProjectSettings(mockProject, { setupScript: "original" });
			await goToProjectTab();

			const textarea = screen.getByDisplayValue("original");
			await user.clear(textarea);
			await user.type(textarea, "changed");

			await user.click(screen.getByText("Save"));

			await vi.waitFor(() => {
				expect(mockSave).toHaveBeenCalledWith(
					expect.objectContaining({ projectId: "proj-1" }),
				);
			});
		});
	});

	describe("worktree tab", () => {
		it("shows instruction when no active worktrees exist", async () => {
			const user = userEvent.setup();
			await renderProjectSettings();
			await user.click(screen.getByText("Worktree Config"));
			expect(screen.getByText(/gear icon/i)).toBeInTheDocument();
		});

		it("shows worktree selector when tasks have worktrees", async () => {
			const user = userEvent.setup();
			await renderProjectSettings(mockProject, {}, [mockTaskWithWorktree]);
			await user.click(screen.getByText("Worktree Config"));
			expect(screen.getByText("Test task")).toBeInTheDocument();
		});
	});

	describe("AI Review persistence (fix #336)", () => {
		it("saves empty builtinColumnAgents when AI Review is disabled", async () => {
			const { api } = await import("../../rpc");
			const mockSave = api.request.updateProjectSettings as ReturnType<typeof vi.fn>;


			const user = userEvent.setup();
			await renderProjectSettings(mockProject, {});
			await goToProjectTab();

			// Disable AI Review
			const toggle = screen.getByRole("switch", { name: /enable ai review/i });
			await user.click(toggle);

			// Save via floating banner
			await user.click(screen.getByText("Save"));

			await vi.waitFor(() => {
				expect(mockSave).toHaveBeenCalledWith(
					expect.objectContaining({
						projectId: "proj-1",
						builtinColumnAgents: {},
					}),
				);
			});
		});
	});
});
