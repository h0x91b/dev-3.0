import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectSettings from "../ProjectSettings";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			createLabel: vi.fn(),
			updateLabel: vi.fn(),
			deleteLabel: vi.fn(),
			detectClonePaths: vi.fn().mockResolvedValue([]),
			getProjectConfigs: vi.fn().mockResolvedValue({ repo: {}, local: {} }),
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

async function renderProjectSettings(project: Project = mockProject, repoConfig = {}) {
	const { api } = await import("../../rpc");
	(api.request.getProjectConfigs as ReturnType<typeof vi.fn>).mockResolvedValue({
		repo: repoConfig,
		local: {},
	});

	const dispatch = vi.fn() as unknown as React.Dispatch<AppAction>;
	const navigate = vi.fn() as (route: Route) => void;
	let result: ReturnType<typeof render>;
	await act(async () => {
		result = render(
			<I18nProvider>
				<ProjectSettings
					projectId={project.id}
					projects={[project]}
					dispatch={dispatch}
					navigate={navigate}
				/>
			</I18nProvider>,
		);
	});
	return result!;
}

describe("ProjectSettings", () => {
	describe("tab navigation", () => {
		it("renders repo and local tabs", async () => {
			await renderProjectSettings();
			expect(screen.getByText("Repo Config")).toBeInTheDocument();
			expect(screen.getByText("Local Overrides")).toBeInTheDocument();
		});

		it("shows repo tab by default", async () => {
			await renderProjectSettings();
			expect(screen.getByText(/Shared team settings/)).toBeInTheDocument();
		});

		it("switches to local tab on click", async () => {
			const user = userEvent.setup();
			await renderProjectSettings();
			await user.click(screen.getByText("Local Overrides"));
			expect(screen.getByText(/Machine-specific overrides/)).toBeInTheDocument();
		});
	});

	describe("repo config form", () => {
		it("populates form from getProjectConfigs", async () => {
			await renderProjectSettings(mockProject, {
				setupScript: "bun install",
				defaultBaseBranch: "develop",
			});

			await vi.waitFor(() => {
				expect(screen.getByDisplayValue("bun install")).toBeInTheDocument();
				expect(screen.getByDisplayValue("develop")).toBeInTheDocument();
			});
		});

		it("setup script textarea has autocapitalize off", async () => {
			await renderProjectSettings(mockProject, { setupScript: "bun install" });
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
			expect(screen.getByText("Clone Paths (Copy-on-Write)")).toBeInTheDocument();
		});

		it("renders existing clone paths from config", async () => {
			await renderProjectSettings(mockProject, {
				clonePaths: ["node_modules", ".venv"],
			});
			await vi.waitFor(() => {
				expect(screen.getByDisplayValue("node_modules")).toBeInTheDocument();
				expect(screen.getByDisplayValue(".venv")).toBeInTheDocument();
			});
		});

		it("renders auto-detect button", async () => {
			await renderProjectSettings(mockProject, { clonePaths: ["node_modules"] });
			expect(screen.getByText("Auto-detect")).toBeInTheDocument();
		});
	});

	describe("peer review toggle", () => {
		it("toggle is on by default (peerReviewEnabled undefined)", async () => {
			await renderProjectSettings();
			const toggle = screen.getByRole("switch", { name: /peer review column/i });
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});

		it("toggle reflects peerReviewEnabled: false from config", async () => {
			await renderProjectSettings(mockProject, { peerReviewEnabled: false });
			await vi.waitFor(() => {
				const toggle = screen.getByRole("switch", { name: /peer review column/i });
				expect(toggle).toHaveAttribute("aria-checked", "false");
			});
		});

		it("clicking toggle flips state", async () => {
			const user = userEvent.setup();
			await renderProjectSettings();
			const toggle = screen.getByRole("switch", { name: /peer review column/i });
			expect(toggle).toHaveAttribute("aria-checked", "true");
			await user.click(toggle);
			expect(toggle).toHaveAttribute("aria-checked", "false");
		});
	});

	describe("unsaved changes banner", () => {
		it("does not show banner when config is clean", async () => {
			await renderProjectSettings(mockProject, { setupScript: "bun install" });
			expect(screen.queryByText("You have unsaved changes")).not.toBeInTheDocument();
		});

		it("shows banner when repo config is modified", async () => {
			const user = userEvent.setup();
			await renderProjectSettings(mockProject, { setupScript: "bun install" });

			const setupInput = screen.getByDisplayValue("bun install");
			await user.clear(setupInput);
			await user.type(setupInput, "npm install");

			expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
		});

		it("shows banner when local config is modified", async () => {
			const user = userEvent.setup();
			await renderProjectSettings();

			await user.click(screen.getByText("Local Overrides"));
			const inputs = screen.getAllByRole("textbox");
			await user.type(inputs[0], "local-setup");

			expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
		});

		it("banner Save button calls saveRepoConfig on repo tab", async () => {
			const { api } = await import("../../rpc");
			const mockSave = api.request.saveRepoConfig as ReturnType<typeof vi.fn>;
			(api.request.getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([mockProject]);

			const user = userEvent.setup();
			await renderProjectSettings(mockProject, { setupScript: "bun install" });

			const setupInput = screen.getByDisplayValue("bun install");
			await user.clear(setupInput);
			await user.type(setupInput, "npm install");

			await user.click(screen.getByText("Save"));

			await vi.waitFor(() => {
				expect(mockSave).toHaveBeenCalledWith(
					expect.objectContaining({ projectId: "proj-1" }),
				);
			});
		});

		it("banner Save button calls saveLocalConfig on local tab", async () => {
			const { api } = await import("../../rpc");
			const mockSave = api.request.saveLocalConfig as ReturnType<typeof vi.fn>;
			(api.request.getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([mockProject]);

			const user = userEvent.setup();
			await renderProjectSettings();

			await user.click(screen.getByText("Local Overrides"));
			const inputs = screen.getAllByRole("textbox");
			await user.type(inputs[0], "local-setup");

			await user.click(screen.getByText("Save"));

			await vi.waitFor(() => {
				expect(mockSave).toHaveBeenCalledWith(
					expect.objectContaining({ projectId: "proj-1" }),
				);
			});
		});

		it("banner disappears after successful save", async () => {
			const { api } = await import("../../rpc");
			(api.request.getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([mockProject]);

			const user = userEvent.setup();
			await renderProjectSettings(mockProject, { setupScript: "bun install" });

			const setupInput = screen.getByDisplayValue("bun install");
			await user.clear(setupInput);
			await user.type(setupInput, "npm install");

			expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
			await user.click(screen.getByText("Save"));

			await vi.waitFor(() => {
				expect(screen.queryByText("You have unsaved changes")).not.toBeInTheDocument();
			});
		});
	});
});
