import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Fiber } from "cordis";
import ActivityOverview from "../../components/ActivityOverview";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { resetPluginsForTests } from "../../plugins/runtime";
import type { Project } from "../../../shared/types";
import type { Route } from "../../state";
import { getProjectActionRegistry, type ProjectActionItem } from "../registry";
import { installProjectActionBuiltins } from "./install-builtins";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
			openFolder: vi.fn(() => Promise.resolve()),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
			reorderSpaces: vi.fn(),
			reorderSpaceProjects: vi.fn(),
			reorderMixedOrder: vi.fn(),
			createSandboxProject: vi.fn(),
			checkHarnessReadiness: vi.fn(() => Promise.resolve({ harnesses: [], usable: ["builtin-claude"], noneInstalled: false })),
		},
	},
}));

const PROJECT = { id: "p1", name: "Real project", path: "/home/user/p1", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" } as Project;
const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setNarrow(narrow: boolean) {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: narrow ? 390 : originalInnerWidth });
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: narrow
			? (query: string) => ({ matches: true, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })
			: originalMatchMedia,
	});
}

async function renderDashboard(navigate: (route: Route) => void = vi.fn()) {
	render(
		<I18nProvider>
			<ActivityOverview projects={[PROJECT]} navigate={navigate} dispatch={vi.fn()} bellCounts={new Map()} onRemoveProject={vi.fn()} onReorderProjects={vi.fn()} />
		</I18nProvider>,
	);
	await screen.findByText("Real project");
	for (let tick = 0; tick < 5; tick++) await act(async () => {});
}

async function openSheet() {
	await userEvent.setup().click(screen.getByTitle("Project actions"));
	return screen.getByTestId("activity-project-action-sheet");
}

const sheetLabels = (sheet: HTMLElement) => [...sheet.querySelectorAll("button span.flex-1")].map((label) => label.textContent);
const rowLabels = () => [...screen.getByLabelText("Project settings").parentElement!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));

const acme = (extra: Partial<ProjectActionItem> = {}): ProjectActionItem => ({
	id: "acme:deploy",
	order: 5,
	region: "actions",
	placements: ["row", "sheet"],
	glyph: "x",
	label: () => "Deploy",
	run: vi.fn(),
	...extra,
});

async function contribute(item: ProjectActionItem, name = "acme"): Promise<Fiber> {
	const fiber = getAppRoot().plugin({ name, inject: ["projectActions"], apply: (ctx) => void ctx.projectActions.register(item) });
	await act(async () => {});
	return fiber;
}

const slotLogs = () => errors.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.startsWith("[projectActions]"));

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
	await installProjectActionBuiltins();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	errors.mockRestore();
	setNarrow(false);
});

describe("projectActions slot", () => {
	it("is a contribution slot with dev3's actions and their placements", () => {
		const registry = getProjectActionRegistry();
		expect(registry.kind).toBe("contribute");
		expect(registry.list().map(({ def }) => [def.id, def.placements.join("+"), def.region])).toEqual([
			["builtin:open-board", "sheet", "actions"],
			["builtin:spaces", "row", "actions"],
			["builtin:settings", "row+sheet", "actions"],
			["builtin:finder", "row+sheet", "actions"],
			["builtin:terminal", "row+sheet", "actions"],
			["builtin:remove", "row+sheet", "danger"],
		]);
	});

	it("keeps another plugin's action off the resting row", async () => {
		await contribute(acme());
		await renderDashboard();
		expect(rowLabels()).not.toContain("Deploy");
		expect(rowLabels()[0]).toBe("Project settings");
		expect(rowLabels().slice(-1)).toEqual(["Remove"]);
	});

	it("orders the sheet: dev3's actions, reorder, others (at most five), then Remove", async () => {
		for (let i = 0; i < 7; i++) await contribute(acme({ id: `acme:a${i}`, label: () => `Extra ${i}` }), `acme${i}`);
		// Even a low-order item that claims danger is drawn with the others, never as dev3's Remove.
		await contribute(acme({ id: "acme:wipe", order: 1, region: "danger", label: () => "Wipe" }), "wipe");
		setNarrow(true);
		await renderDashboard();
		const sheet = await openSheet();
		expect(sheetLabels(sheet)).toEqual([
			"Open board", "Project settings", "Open in Finder", "Open terminal", "Move project up", "Move project down",
			"Wipe", "Extra 0", "Extra 1", "Extra 2", "Extra 3", "Remove",
		]);
		expect(within(sheet).getByText("Wipe").closest("button")!.className).not.toContain("text-danger");
		expect(within(sheet).getByText("Remove").closest("button")!.className).toContain("text-danger");
	});

	it("runs an action with the project and closes the sheet first", async () => {
		const run = vi.fn();
		await contribute(acme({ run }));
		setNarrow(true);
		await renderDashboard();
		await userEvent.setup().click(within(await openSheet()).getByText("Deploy"));
		expect(screen.queryByTestId("activity-project-action-sheet")).toBeNull();
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ project: PROJECT, placement: "sheet" }));
	});

	it("drops a throwing or malformed item, keeps dev3's, and logs each once", async () => {
		await contribute(acme({ id: "acme:when", when: () => { throw new Error("when boom"); } }), "when");
		await contribute(acme({ id: "acme:glyph", glyph: { not: "a glyph" } as never }), "glyph");
		setNarrow(true);
		await renderDashboard();
		const user = userEvent.setup();
		for (let i = 0; i < 2; i++) {
			const sheet = await openSheet();
			expect(sheetLabels(sheet)).toContain("Project settings");
			expect(sheetLabels(sheet)).not.toContain("Deploy");
			await user.click(within(sheet).getByText("Open board"));
		}
		expect(slotLogs().sort()).toEqual(['[projectActions] "acme:glyph" failed to resolve', '[projectActions] "acme:when" failed to resolve']);
	});

	it("logs every failing run and keeps the dashboard", async () => {
		await contribute(acme({ run: () => { throw new Error("run boom"); } }));
		setNarrow(true);
		await renderDashboard();
		const user = userEvent.setup();
		await user.click(within(await openSheet()).getByText("Deploy"));
		await user.click(within(await openSheet()).getByText("Deploy"));
		expect(slotLogs()).toEqual(['[projectActions] "acme:deploy" failed', '[projectActions] "acme:deploy" failed']);
		expect(screen.getByText("Real project")).toBeInTheDocument();
	});

	it("draws dev3's actions before the built-ins have registered", async () => {
		resetPluginsForTests();
		await renderDashboard();
		expect(screen.getByLabelText("Project settings")).toBeInTheDocument();
		expect(screen.getByLabelText("Remove")).toBeInTheDocument();
	});

	it("[dispose] drops a plugin's action from the open sheet when the plugin unloads, keeping dev3's", async () => {
		const fiber = await contribute(acme());
		setNarrow(true);
		await renderDashboard();
		const sheet = await openSheet();
		expect(within(sheet).getByText("Deploy")).toBeInTheDocument();
		await act(async () => {
			await fiber.dispose();
		});
		expect(getProjectActionRegistry().get("acme:deploy")).toBeUndefined();
		expect(within(sheet).queryByText("Deploy")).toBeNull();
		expect(within(sheet).getByText("Remove")).toBeInTheDocument();
	});
});
