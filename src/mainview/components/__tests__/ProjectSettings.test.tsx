import { render, screen } from "@testing-library/react";
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
});
