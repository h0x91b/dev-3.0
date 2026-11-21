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

	it("falls back to the built-in under the inline notice when the slot's sidebar throws", async () => {
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
		expect(screen.getByRole("alert").textContent).toBe("This sidebar failed to load, so the built-in Active Tasks list is shown.");
		expect(screen.getByTestId("active-tasks").textContent).toContain("t1/s1");
		errors.mockRestore();
	});

	it("refuses a sidebar rendered outside any host", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Orphan = () => <div>{String(useSidebarProps())}</div>;
		expect(() => render(<Orphan />)).toThrow("sidebar rendered outside any <Sidebar>");
		errors.mockRestore();
	});
});
