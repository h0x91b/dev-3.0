import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import GoToPalette, { type GoToMode } from "../GoToPalette";
import { installGoToSourceBuiltins } from "../../go-to-sources/__tests__/install-builtins";
import type { Project, Space, Task } from "../../../shared/types";
import { recordNavVisit } from "../../utils/recentNav";
import { recordTaskVisit } from "../../utils/recentTasks";

/**
 * Pins the palette's result order for a fixed query set in every mode, so moving
 * its row sources onto a slot cannot reorder anything: same query → same rows.
 */

const SPACES: Space[] = [{ id: "sp_a", name: "Client billing", parentId: null, projectIds: ["p3"], createdAt: 1 } as Space];
vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn(() => Promise.resolve([])),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: SPACES, order: ["sp_a"] })),
			getAllProjectTasks: vi.fn(() => Promise.resolve(TASKS_BY_PROJECT)),
			getTaskLineage: vi.fn(() => Promise.resolve({ nodes: [] })),
			getEpics: vi.fn(() => Promise.resolve({ version: 1, epics: [] })),
		},
	},
}));

const project = (id: string, name: string, over: Partial<Project> = {}): Project =>
	({ id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "", labels: [{ id: "lb", name: "bug", color: "#f00" }], ...over }) as Project;
const task = (id: string, seq: number, projectId: string, title: string, over: Partial<Task> = {}): Task =>
	({ id, seq, projectId, title, description: title, status: "in-progress", worktreePath: `/tmp/${id}`, ...over }) as Task;

const OPS: Project = project("ops", "Operations", { kind: "virtual", builtin: true } as Partial<Project>);
const PROJECTS: Project[] = [project("p1", "users-service"), project("p2", "auth-gateway"), project("p3", "billing"), OPS];
const TASKS: Task[] = [
	task("a", 1, "p1", "Fix auth race in login"),
	task("b", 2, "p1", "Add billing export", { labelIds: ["lb"] }),
	task("c", 3, "p2", "Refactor auth tokens", { status: "review-by-user" }),
	task("d", 4, "p2", "Investigate flaky users test", { labelIds: ["lb"] }),
	task("e", 5, "p3", "Billing dashboard polish", { status: "todo" }),
	task("f", 6, "p1", "users list pagination"),
	// Competes on "client" with `billing`, which only matches through its space's name.
	task("g", 7, "p1", "Refresh the monthly invoice totals per client"),
];
const TASKS_BY_PROJECT = ["p1", "p2", "p3"].map((projectId) => ({ projectId, tasks: TASKS.filter((t) => t.projectId === projectId), todoCount: 0 }));

const QUERIES = ["", "auth", "bil", "users", "label:bug", "status:todo", "#3", "zzz", "client"];

function renderPalette(mode: GoToMode, currentTaskId?: string) {
	return render(
		<I18nProvider>
			<GoToPalette
				mode={mode}
				onModeChange={() => {}}
				projects={PROJECTS}
				shortcutIndexById={{ p1: 0, p2: 1, p3: 2 }}
				projectById={new Map(PROJECTS.map((p) => [p.id, p]))}
				taskPorts={new Map()}
				currentTaskId={currentTaskId}
				onSelectProject={() => {}}
				onSelectSpace={() => {}}
				onSelectTask={() => {}}
				onClose={() => {}}
			/>
		</I18nProvider>,
	);
}

/** Each query's rows as their visible text, or the empty-state line when none match. */
async function resultsFor(mode: GoToMode, currentTaskId?: string): Promise<Record<string, string[]>> {
	const user = userEvent.setup();
	renderPalette(mode, currentTaskId);
	if (mode !== "project") await waitFor(() => expect(screen.queryByText("Loading tasks…")).toBeNull());
	await waitFor(() => expect(screen.getAllByRole("option").some((o) => o.textContent?.includes("Client billing"))).toBe(mode !== "task"));
	const input = screen.getByRole("textbox");
	const out: Record<string, string[]> = {};
	for (const q of QUERIES) {
		await user.clear(input);
		if (q) await user.type(input, q);
		await act(async () => {});
		const options = screen.queryAllByRole("option").map((o) => o.textContent ?? "");
		out[q || "(empty)"] = options.length ? options : [`<none> ${screen.getByTestId("go-to-palette").querySelector("p.text-fg-muted")?.textContent ?? ""}`];
	}
	return out;
}

beforeEach(async () => {
	await installGoToSourceBuiltins();
	localStorage.clear();
	// One visit timeline: projects and tasks interleaved, newest last.
	for (const key of ["p:p2", "t:c", "p:p1", "t:a", "t:f"]) recordNavVisit(key);
	for (const id of ["d", "c", "a", "f"]) recordTaskVisit(id);
});

describe("Go-to palette ranking", () => {
	it("project mode", async () => {
		expect(await resultsFor("project")).toMatchInlineSnapshot(`
			{
			  "#3": [
			    "<none> No matching projects",
			  ],
			  "(empty)": [
			    "users-service⌘1",
			    "auth-gateway⌘2",
			    "billing⌘3",
			    "[ Operations ]⌘0",
			    "Client billingAll projects in this space",
			  ],
			  "auth": [
			    "auth-gateway",
			  ],
			  "bil": [
			    "billing",
			    "Client billingAll projects in this space",
			  ],
			  "client": [
			    "Client billingAll projects in this space",
			    "billing",
			  ],
			  "label:bug": [
			    "<none> No matching projects",
			  ],
			  "status:todo": [
			    "<none> No matching projects",
			  ],
			  "users": [
			    "users-service",
			  ],
			  "zzz": [
			    "<none> No matching projects",
			  ],
			}
		`);
	});

	it("task mode, with the task on screen sunk to the bottom", async () => {
		expect(await resultsFor("task", "f")).toMatchInlineSnapshot(`
			{
			  "#3": [
			    "Refactor auth tokensauth-gateway · #3",
			  ],
			  "(empty)": [
			    "Fix auth race in loginusers-service · #1",
			    "Refactor auth tokensauth-gateway · #3",
			    "Investigate flaky users testauth-gateway · #4",
			    "Refresh the monthly invoice totals per clientusers-service · #7",
			    "Billing dashboard polishbilling · #5",
			    "Add billing exportusers-service · #2",
			    "users list paginationusers-service · #6",
			  ],
			  "auth": [
			    "Fix auth race in loginusers-service · #1",
			    "Refactor auth tokensauth-gateway · #3",
			  ],
			  "bil": [
			    "Billing dashboard polishbilling · #5",
			    "Add billing exportusers-service · #2",
			  ],
			  "client": [
			    "Refresh the monthly invoice totals per clientusers-service · #7",
			  ],
			  "label:bug": [
			    "Investigate flaky users testauth-gateway · #4",
			    "Add billing exportusers-service · #2",
			  ],
			  "status:todo": [
			    "Billing dashboard polishbilling · #5",
			  ],
			  "users": [
			    "users list paginationusers-service · #6",
			    "Investigate flaky users testauth-gateway · #4",
			  ],
			  "zzz": [
			    "<none> No matching tasks",
			  ],
			}
		`);
	});

	it("combined mode, with the task on screen sunk to the bottom", async () => {
		expect(await resultsFor("combined", "f")).toMatchInlineSnapshot(`
			{
			  "#3": [
			    "Refactor auth tokensauth-gateway · #3",
			  ],
			  "(empty)": [
			    "Fix auth race in loginusers-service · #1",
			    "users-service⌘1",
			    "Refactor auth tokensauth-gateway · #3",
			    "auth-gateway⌘2",
			    "billing⌘3",
			    "[ Operations ]⌘0",
			    "Investigate flaky users testauth-gateway · #4",
			    "Refresh the monthly invoice totals per clientusers-service · #7",
			    "Billing dashboard polishbilling · #5",
			    "Add billing exportusers-service · #2",
			    "Client billingAll projects in this space",
			    "users list paginationusers-service · #6",
			  ],
			  "auth": [
			    "auth-gateway",
			    "Fix auth race in loginusers-service · #1",
			    "Refactor auth tokensauth-gateway · #3",
			  ],
			  "bil": [
			    "billing",
			    "Billing dashboard polishbilling · #5",
			    "Add billing exportusers-service · #2",
			    "Client billingAll projects in this space",
			  ],
			  "client": [
			    "Client billingAll projects in this space",
			    "billing",
			    "Refresh the monthly invoice totals per clientusers-service · #7",
			  ],
			  "label:bug": [
			    "Investigate flaky users testauth-gateway · #4",
			    "Add billing exportusers-service · #2",
			  ],
			  "status:todo": [
			    "Billing dashboard polishbilling · #5",
			  ],
			  "users": [
			    "users-service",
			    "users list paginationusers-service · #6",
			    "Investigate flaky users testauth-gateway · #4",
			  ],
			  "zzz": [
			    "<none> No matches",
			  ],
			}
		`);
	});
});
