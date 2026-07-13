import { render, screen } from "@testing-library/react";
import ActiveTasksStrip from "../ActiveTasksStrip";
import type { CodingAgent, Project, Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

const geminiAgent: CodingAgent = {
	id: "builtin-gemini",
	name: "Gemini",
	baseCommand: "gemini",
	isDefault: true,
	configurations: [
		{ id: "gemini-default", name: "Default (3.1 Pro)", model: "gemini-3.1-pro-preview" },
	],
	defaultConfigId: "gemini-default",
};

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function makeTask(overrides?: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 494,
		projectId: "p1",
		title: "Привет! как сам?",
		description: "Привет! как сам?",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/wt",
		branchName: "feat/test",
		groupId: "g1",
		variantIndex: 1,
		agentId: "builtin-gemini",
		configId: "gemini-default",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

describe("ActiveTasksStrip", () => {
	it("renders compact agent summary and variant dots", () => {
		render(
			<I18nProvider>
				<ActiveTasksStrip
					project={project}
					tasks={[
						makeTask(),
						makeTask({ id: "t2", variantIndex: 2 }),
					]}
					activeTaskId="t1"
					navigate={vi.fn()}
					agents={[geminiAgent]}
					bellCounts={new Map()}
				/>
			</I18nProvider>,
		);

		expect(screen.getAllByRole("img", { name: "Gemini" })).toHaveLength(2);
		expect(screen.getAllByText("Gemini · 3.1 Pro")).toHaveLength(2);
		expect(screen.getByTestId("variant-indicator-t1")).toBeInTheDocument();
	});
});
