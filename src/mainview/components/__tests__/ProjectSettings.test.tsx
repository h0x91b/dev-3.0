import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectSettings from "../ProjectSettings";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";
import type { AppAction, Route } from "../../state";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			updateProjectSettings: vi.fn(),
			createLabel: vi.fn(),
			updateLabel: vi.fn(),
			deleteLabel: vi.fn(),
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

function renderProjectSettings(project: Project = mockProject) {
	const dispatch = vi.fn() as unknown as React.Dispatch<AppAction>;
	const navigate = vi.fn() as (route: Route) => void;
	return render(
		<I18nProvider>
			<ProjectSettings
				projectId={project.id}
				projects={[project]}
				dispatch={dispatch}
				navigate={navigate}
			/>
		</I18nProvider>,
	);
}

describe("ProjectSettings", () => {
	describe("autocapitalize disabled on technical inputs", () => {
		it("setup script textarea has autocapitalize off", () => {
			renderProjectSettings();
			const textarea = screen.getByDisplayValue("bun install");
			expect(textarea).toHaveAttribute("autocapitalize", "off");
			expect(textarea).toHaveAttribute("autocorrect", "off");
			expect(textarea.getAttribute("spellcheck")).toBe("false");
		});

		it("dev script textarea has autocapitalize off", () => {
			renderProjectSettings();
			const textarea = screen.getByDisplayValue("bun dev");
			expect(textarea).toHaveAttribute("autocapitalize", "off");
			expect(textarea).toHaveAttribute("autocorrect", "off");
			expect(textarea.getAttribute("spellcheck")).toBe("false");
		});

		it("cleanup script textarea has autocapitalize off", () => {
			renderProjectSettings();
			const textarea = screen.getByDisplayValue("rm -rf dist");
			expect(textarea).toHaveAttribute("autocapitalize", "off");
			expect(textarea).toHaveAttribute("autocorrect", "off");
			expect(textarea.getAttribute("spellcheck")).toBe("false");
		});

		it("base branch input has autocapitalize off", () => {
			renderProjectSettings();
			const input = screen.getByDisplayValue("main");
			expect(input).toHaveAttribute("autocapitalize", "off");
			expect(input).toHaveAttribute("autocorrect", "off");
			expect(input.getAttribute("spellcheck")).toBe("false");
		});
	});

	describe("clone paths section", () => {
		it("renders the clone paths section", () => {
			renderProjectSettings();
			expect(screen.getByText("Clone Paths (Copy-on-Write)")).toBeInTheDocument();
			expect(screen.getByText(/Directories and files to clone/)).toBeInTheDocument();
		});

		it("renders existing clone paths from project", () => {
			const projectWithPaths: Project = {
				...mockProject,
				clonePaths: ["node_modules", ".venv"],
			};
			renderProjectSettings(projectWithPaths);
			expect(screen.getByDisplayValue("node_modules")).toBeInTheDocument();
			expect(screen.getByDisplayValue(".venv")).toBeInTheDocument();
		});

		it("can add a new clone path", async () => {
			const user = userEvent.setup();
			renderProjectSettings();
			const addButton = screen.getByText("+ Add Path");
			await user.click(addButton);
			// After adding, a new empty input should appear
			const inputs = screen.getAllByPlaceholderText("node_modules");
			expect(inputs.length).toBeGreaterThanOrEqual(1);
		});

		it("can remove a clone path", async () => {
			const user = userEvent.setup();
			const projectWithPaths: Project = {
				...mockProject,
				clonePaths: ["node_modules"],
			};
			renderProjectSettings(projectWithPaths);
			expect(screen.getByDisplayValue("node_modules")).toBeInTheDocument();
			// Click the × button
			const removeButton = screen.getByText("×");
			await user.click(removeButton);
			expect(screen.queryByDisplayValue("node_modules")).not.toBeInTheDocument();
		});

		it("includes clone paths in save payload", async () => {
			const { api } = await import("../../rpc");
			const mockUpdate = api.request.updateProjectSettings as ReturnType<typeof vi.fn>;
			mockUpdate.mockResolvedValueOnce({ ...mockProject, clonePaths: ["node_modules"] });

			const user = userEvent.setup();
			const projectWithPaths: Project = {
				...mockProject,
				clonePaths: ["node_modules"],
			};
			const dispatch = vi.fn();
			const navigate = vi.fn();
			render(
				<I18nProvider>
					<ProjectSettings
						projectId={projectWithPaths.id}
						projects={[projectWithPaths]}
						dispatch={dispatch as unknown as React.Dispatch<AppAction>}
						navigate={navigate as (route: Route) => void}
					/>
				</I18nProvider>,
			);

			const saveButton = screen.getByText("Save Settings");
			await user.click(saveButton);

			expect(mockUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					clonePaths: ["node_modules"],
				}),
			);
		});
	});
});
