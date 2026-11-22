import type { MockInstance } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Context } from "cordis";
import type { Project, Task } from "../../../shared/types";
import TaskDetailModal from "../../components/TaskDetailModal";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_TASK_DETAIL_SECTIONS } from "../builtins";
import { getTaskDetailSectionRegistry, type TaskDetailSectionItem } from "../registry";
import { resetTaskDetailFailuresForTests } from "../TaskDetailSections";
import { installTaskDetailSectionBuiltins } from "./install-builtins";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getTaskLineage: vi.fn(() => new Promise(() => {})),
			getEpics: vi.fn(() => new Promise(() => {})),
			getTaskTerminalBackend: vi.fn(() => new Promise(() => {})),
			getNativeTerminalAvailability: vi.fn(() => new Promise(() => {})),
		},
	},
}));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));

const project = { id: "p1", name: "P", path: "/p", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" } as Project;
const task = {
	id: "t1", seq: 7, projectId: "p1", title: "Finished", description: "Finished", status: "completed", baseBranch: "main",
	worktreePath: null, branchName: "feat/x", groupId: null, variantIndex: null, agentId: null, configId: null,
	createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z",
} as Task;

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function contribute(...items: TaskDetailSectionItem[]) {
	return getAppRoot().plugin({ name: "detail-probe", inject: ["taskDetailSections"], apply: (ctx: Context) => { for (const item of items) ctx.taskDetailSections.register(item); } });
}

const section = (id: string, order = 0): TaskDetailSectionItem => ({ id, region: "main", order, title: () => `Title ${id}`, component: () => <p>Body {id}</p> });
const row = (id: string): TaskDetailSectionItem => ({ id, region: "meta", label: () => `Label ${id}`, value: () => <>Value {id}</> });

function renderModal() {
	render(<I18nProvider><TaskDetailModal task={task} project={project} dispatch={vi.fn()} onClose={vi.fn()} /></I18nProvider>);
}

let errors: MockInstance<typeof console.error>;

beforeEach(async () => {
	resetPluginsForTests();
	resetTaskDetailFailuresForTests();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
	await installTaskDetailSectionBuiltins();
});

afterEach(() => vi.restoreAllMocks());

describe("taskDetailSections slot", () => {
	it("registers the finished task's body in display order", () => {
		expect(getTaskDetailSectionRegistry().list().map((entry) => entry.def)).toEqual(BUILTIN_TASK_DETAIL_SECTIONS);
	});

	it("[dispose] unloading the plugin that added a section takes it out of the open view", async () => {
		const probe = contribute(section("probe:a"), row("probe:r"));
		await settle();
		renderModal();
		await settle();
		expect(screen.getByRole("region", { name: "Title probe:a" })).toHaveTextContent("Body probe:a");
		expect(screen.getByText("Label probe:r")).toBeInTheDocument();

		await act(() => probe.dispose());

		expect(screen.queryByText("Body probe:a")).toBeNull();
		expect(screen.queryByText("Label probe:r")).toBeNull();
		expect(screen.getByText("Notes")).toBeInTheDocument();
	});

	it("keeps every extension after the built-ins, whatever its order", async () => {
		contribute(section("probe:first", -1000), row("probe:row"));
		await settle();
		renderModal();
		await settle();
		const notes = screen.getByText("Notes");
		const extension = screen.getByText("Body probe:first");
		expect(notes.compareDocumentPosition(extension) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const updated = screen.getByText("Updated");
		expect(updated.compareDocumentPosition(screen.getByText("Label probe:row")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows two extension sections and folds the rest behind one disclosure", async () => {
		contribute(section("probe:1"), section("probe:2"), section("probe:3"));
		await settle();
		renderModal();
		await settle();
		expect(screen.getByText("Body probe:1")).toBeInTheDocument();
		expect(screen.getByText("Body probe:2")).toBeInTheDocument();
		expect(screen.queryByText("Body probe:3")).toBeNull();
		const more = screen.getByRole("button", { name: "1 more from extensions" });
		expect(more).toHaveAttribute("aria-expanded", "false");

		await userEvent.click(more);

		expect(more).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Body probe:3")).toBeInTheDocument();
	});

	it("draws three extension rows and drops the fourth, logging it once", async () => {
		contribute(row("probe:1"), row("probe:2"), row("probe:3"), row("probe:4"));
		await settle();
		renderModal();
		await settle();
		expect(["probe:1", "probe:2", "probe:3"].map((id) => screen.getByText(`Label ${id}`))).toHaveLength(3);
		expect(screen.queryByText("Label probe:4")).toBeNull();
		expect(errors.mock.calls.filter((call) => String(call[0]).includes("probe:4"))).toHaveLength(1);
	});

	it("logs a throwing when() once per item, however often the view re-renders", async () => {
		contribute({ ...section("probe:bad"), when: () => { throw new Error("boom"); } });
		await settle();
		const { rerender } = render(<I18nProvider><TaskDetailModal task={task} project={project} dispatch={vi.fn()} onClose={vi.fn()} /></I18nProvider>);
		await settle();
		rerender(<I18nProvider><TaskDetailModal task={{ ...task, updatedAt: "2025-01-03T00:00:00Z" }} project={project} dispatch={vi.fn()} onClose={vi.fn()} /></I18nProvider>);
		await settle();
		expect(errors.mock.calls.filter((call) => String(call[0]).includes("probe:bad"))).toHaveLength(1);
	});

	it("leaves a notice where a built-in section crashed, and the rest of the view working", async () => {
		contribute({ id: "builtin:probe.crash", region: "main", component: () => { throw new Error("boom"); } });
		await settle();
		renderModal();
		await settle();
		expect(within(screen.getByTestId("archived-task-modal")).getByRole("alert")).toHaveTextContent("This section could not be shown");
		expect(screen.getByText("Notes")).toBeInTheDocument();
	});
});
