import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import type { ActiveTasksSidebarProps } from "../../components/ActiveTasksSidebar";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { ACTIVE_TASKS_SIDEBAR_ID, BUILTIN_SIDEBAR_PLUGIN } from "../builtins";
import { useSidebarProps } from "../props";
import { getSidebarRegistry } from "../registry";
import { Sidebar } from "../Sidebar";

vi.mock("../../rpc", () => ({ api: { request: {} } }));
vi.mock("../../components/ActiveTasksSidebar", () => ({
	default: ({ activeTaskId, spaceId, navigate }: ActiveTasksSidebarProps) => (
		<div data-testid="active-tasks">
			{`${activeTaskId}/${spaceId}`}
			<button type="button" onClick={() => navigate({ screen: "dashboard" })}>
				navigate
			</button>
		</div>
	),
}));

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function renderSidebar(navigate: ActiveTasksSidebarProps["navigate"] = () => {}) {
	return render(
		<I18nProvider>
			<Sidebar
				activeTaskId="t1"
				spaceId="s1"
				dispatch={() => {}}
				navigate={navigate}
				agents={[]}
				bellCounts={new Map()}
				taskPorts={new Map()}
			/>
		</I18nProvider>,
	);
}

beforeEach(() => resetPluginsForTests());

describe("Sidebar slot", () => {
	it("draws the built-in Active Tasks list from the slot with the host's props", async () => {
		applyBuiltinPlugins([], [BUILTIN_SIDEBAR_PLUGIN]);
		await settle();
		expect(getSidebarRegistry().list().map((entry) => entry.def.id)).toEqual([ACTIVE_TASKS_SIDEBAR_ID]);
		const navigate = vi.fn();
		renderSidebar(navigate);
		expect(screen.getByTestId("active-tasks").textContent).toContain("t1/s1");
		fireEvent.click(screen.getByText("navigate"));
		expect(navigate).toHaveBeenCalledWith({ screen: "dashboard" });
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("draws the built-in before anything has registered", () => {
		renderSidebar();
		expect(screen.getByTestId("active-tasks")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// Boom takes the built-in's id from a plain (non-extension) plugin: this proves the boundary and the
	// notice, not what a real replacement looks like — no extension may register here while the slot is internal.
	it("falls back to the built-in under a compact inline notice that leaves the list room, when the slot's sidebar throws", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Boom = () => {
			throw new Error("boom");
		};
		getAppRoot().plugin({
			name: "throwing-sidebar",
			inject: ["sidebar"],
			apply(ctx: Context) {
				ctx.sidebar.register({ id: ACTIVE_TASKS_SIDEBAR_ID, component: Boom });
			},
		});
		await settle();
		renderSidebar();
		const notice = screen.getByRole("alert");
		expect(notice.textContent).toBe("This sidebar failed to load, so the built-in Active Tasks list is shown.");
		expect(notice.className).toContain("mx-2");
		expect(screen.getByTestId("active-tasks").textContent).toContain("t1/s1");
		// The list sits in a shrinkable flex child beside the notice, so an `h-full` list cannot overflow by its height.
		// happy-dom has no layout: these class checks are a structural proxy; the geometry was measured in a real browser (<pr:2392>).
		const listBox = screen.getByTestId("active-tasks").parentElement!;
		expect(listBox.className.split(" ")).toEqual(expect.arrayContaining(["flex-1", "min-h-0"]));
		expect(listBox.parentElement).toBe(notice.parentElement);
		expect(notice.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col", "flex-1", "min-h-0"]));
		errors.mockRestore();
	});

	it("refuses a sidebar rendered outside any host", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Orphan = () => <div>{String(useSidebarProps())}</div>;
		expect(() => render(<Orphan />)).toThrow("sidebar rendered outside any <Sidebar>");
		errors.mockRestore();
	});
});
