import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActivityOverview from "../ActivityOverview";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";

/**
 * Pins the per-project actions on the dashboard — the wide row cluster and the
 * narrow kebab sheet — as rendered DOM, so moving them onto a slot cannot change
 * a class, a glyph, a label or the order.
 */

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAllProjectTasks: vi.fn(() => Promise.resolve([])),
			openFolder: vi.fn(),
			getSpaces: vi.fn(),
			reorderSpaces: vi.fn(),
			reorderSpaceProjects: vi.fn(),
			reorderMixedOrder: vi.fn(),
			createSandboxProject: vi.fn(),
			checkHarnessReadiness: vi.fn(() => Promise.resolve({ harnesses: [], usable: ["builtin-claude"], noneInstalled: false })),
		},
	},
}));

import { api } from "../../rpc";

const project = (id: string, name: string, over: Partial<Project> = {}): Project =>
	({ id, name, path: `/home/user/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z", ...over }) as Project;

const REAL = project("p1", "Real project");
const SECOND = project("p2", "Second project");
const VIRTUAL = project("v1", "Virtual board", { kind: "virtual" } as Partial<Project>);
const OPS = project("ops", "Operations", { kind: "virtual", builtin: true } as Partial<Project>);
const PROJECTS = [OPS, REAL, SECOND, VIRTUAL];

interface Case {
	spaces: boolean;
	reorder: boolean;
	remove: boolean;
}

const CASES: Record<string, Case> = {
	"default (no spaces, reorderable, removable)": { spaces: false, reorder: true, remove: true },
	"with spaces": { spaces: true, reorder: true, remove: true },
	"not reorderable": { spaces: false, reorder: false, remove: true },
	"without onRemoveProject": { spaces: false, reorder: true, remove: false },
};

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

async function renderBoard(c: Case) {
	vi.mocked(api.request.getSpaces).mockResolvedValue(
		c.spaces
			? { version: 1, spaces: [{ id: "sp_a", name: "Client X", parentId: null, projectIds: ["p1"], createdAt: 1 }], order: ["sp_a"] }
			: { version: 1, spaces: [], order: [] },
	);
	const view = render(
		<I18nProvider>
			<ActivityOverview
				projects={PROJECTS}
				navigate={vi.fn()}
				dispatch={vi.fn()}
				bellCounts={new Map()}
				onRemoveProject={c.remove ? vi.fn() : undefined}
				onReorderProjects={c.reorder ? vi.fn() : undefined}
			/>
		</I18nProvider>,
	);
	await screen.findByText("Real project");
	for (let tick = 0; tick < 10; tick++) await act(async () => {});
	return view;
}

/** The row's own button carries the project name; the cluster and the kebab are its siblings. */
function rowOf(name: string): HTMLElement {
	return screen.getAllByText(name)[0].closest("button")!.parentElement!;
}

async function clusters(c: Case): Promise<Record<string, string>> {
	setNarrow(false);
	const view = await renderBoard(c);
	const out: Record<string, string> = {};
	for (const p of PROJECTS) {
		const settings = within(rowOf(p.id === OPS.id ? "[ Operations ]" : p.name)).getByLabelText("Project settings");
		out[p.id] = settings.parentElement!.parentElement!.outerHTML;
	}
	view.unmount();
	return out;
}

async function sheets(c: Case): Promise<Record<string, string>> {
	setNarrow(true);
	const user = userEvent.setup();
	const out: Record<string, string> = {};
	// A fresh board per project: each sheet opens from the same resting state.
	for (const p of PROJECTS) {
		const view = await renderBoard(c);
		await user.click(within(rowOf(p.id === OPS.id ? "[ Operations ]" : p.name)).getByTitle("Project actions"));
		out[p.id] = (await screen.findByTestId("activity-project-action-sheet")).outerHTML;
		view.unmount();
	}
	return out;
}

afterEach(() => setNarrow(false));

describe("dashboard project actions pin", () => {
	it.each(Object.entries(CASES))("wide row cluster: %s", async (_name, c) => {
		expect(await clusters(c)).toMatchSnapshot();
	});

	it.each(Object.entries(CASES))("narrow action sheet: %s", async (_name, c) => {
		expect(await sheets(c)).toMatchSnapshot();
	});
});
