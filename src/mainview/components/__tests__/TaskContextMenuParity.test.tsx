import { cleanup, render } from "@testing-library/react";
import TaskContextMenu from "../TaskContextMenu";
import { I18nProvider } from "../../i18n";
import type { Project, Task } from "../../../shared/types";

vi.mock("../../rpc", () => ({ api: { request: {} } }));
vi.mock("../../analytics", () => ({ trackEvent: vi.fn(), agentNameFromId: vi.fn(() => "unknown") }));

const project = {
	id: "p1",
	name: "Proj",
	path: "/tmp/p1",
	labels: [{ id: "l1", name: "Bug", color: "#ef4444" }],
} as unknown as Project;

const BASE: Partial<Task> = {
	id: "t1",
	projectId: "p1",
	description: "My task",
	worktreePath: "/tmp/worktree",
	branchName: "dev3/test",
	createdAt: 0,
};

/** Every task state that changes a row's presence, label, check mark or enabled state. */
const TASKS: Record<string, Partial<Task>> = {
	"todo, no worktree": { status: "todo", worktreePath: undefined, branchName: undefined },
	"todo draft": { status: "todo", worktreePath: undefined, branchName: undefined, draft: true },
	"todo with start-after": { status: "todo", worktreePath: undefined, launchAfter: { taskId: "t0" } as Task["launchAfter"] },
	"todo scheduled": { status: "todo", worktreePath: undefined, scheduledLaunch: { at: 1 } as Task["scheduledLaunch"] },
	"in-progress live": { status: "in-progress" },
	"in-progress draft": { status: "in-progress", draft: true },
	"in-progress hibernated": { status: "in-progress", hibernated: true },
	"in-progress preparing": { status: "in-progress", preparing: true },
	"in-progress shutting down": { status: "in-progress", shuttingDown: true },
	"user-questions live": { status: "user-questions" },
	"review-by-ai live": { status: "review-by-ai" },
	"review-by-user live": { status: "review-by-user" },
	"in-progress, no branch": { status: "in-progress", branchName: undefined },
	"in-progress watched, hidden, keep-alive": { status: "in-progress", watched: true, hidden: true, keepAlive: { enabled: true } as Task["keepAlive"] },
	completed: { status: "completed", worktreePath: undefined },
	cancelled: { status: "cancelled", worktreePath: undefined },
};

/** The props each surface passes: the card owns a detail modal and lineage, the sidebar row and board views do not. */
const SURFACES = {
	card: { onOpenDetails: () => {}, onShowFamily: () => {} },
	sidebar: {},
	board: {},
} as const;

function readMenu(): string[] {
	const menu = document.querySelector('[role="menu"]');
	if (!menu) return ["<no menu>"];
	return [...menu.querySelectorAll("[data-menu-row], .border-t")].map((el) => {
		if (!el.hasAttribute("data-menu-row")) return "---";
		const button = el as HTMLButtonElement;
		const [check, label, arrow] = [...button.querySelectorAll("span")].map((s) => s.textContent ?? "");
		const flags = [
			check === "✓" && "checked",
			button.disabled && "disabled",
			button.className.includes("text-danger") && "danger",
			arrow === "▸" && "submenu",
		].filter(Boolean);
		return `${button.dataset.testid} | ${label}${flags.length ? ` | ${flags.join(",")}` : ""}`;
	});
}

function snapshotAll(): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [surface, extra] of Object.entries(SURFACES)) {
		for (const [state, overrides] of Object.entries(TASKS)) {
			render(
				<I18nProvider>
					<TaskContextMenu
						task={{ ...BASE, ...overrides } as Task}
						project={project}
						dispatch={vi.fn()}
						pos={{ x: 40, y: 60 }}
						onClose={vi.fn()}
						onOpenTask={vi.fn()}
						{...extra}
					/>
				</I18nProvider>,
			);
			out[`${surface} / ${state}`] = readMenu();
			cleanup();
		}
	}
	return out;
}

// Recorded from the hard-coded group lists the taskMenu slot replaced; never regenerate it to make a change pass.
describe("task context menu parity", () => {
	it("shows the same rows, order and states on every surface (desktop)", () => {
		expect(snapshotAll()).toMatchSnapshot();
	});

	describe("on a phone", () => {
		const width = window.innerWidth;
		const matchMedia = window.matchMedia;
		beforeEach(() => {
			Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
			window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: query.includes("max-width") })) as typeof window.matchMedia;
		});
		afterEach(() => {
			Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
			window.matchMedia = matchMedia;
		});

		it("shows the same rows, order and states in the bottom sheet", () => {
			expect(snapshotAll()).toMatchSnapshot();
		});
	});
});
