import { act, render, screen } from "@testing-library/react";
import type { Context, Fiber } from "cordis";
import { I18nProvider } from "../../i18n";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { getAppRoot } from "../../plugins/root";
import type { Project, Task } from "../../../shared/types";
import { BUILTIN_TASK_HEADER_PLUGIN, legacyClusterId } from "../builtins";
import { getTaskHeaderRegistry, TASK_HEADER_REGIONS, type TaskHeaderRegion } from "../registry";
import { TaskHeaderProvider, TaskHeaderRegionItems, type LegacyClusters } from "../scope";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

const task = { id: "t1", projectId: "p1", title: "Task", status: "in-progress" } as Task;
const project = { id: "p1", name: "Project" } as Project;

function clusters(surface: "bar" | "sheet"): LegacyClusters {
	const make = (region: TaskHeaderRegion) => ({ [surface]: <span data-testid={`legacy-${region}-${surface}`}>{region}</span> });
	return { status: make("status"), session: make("session"), git: make("git"), runtime: make("runtime") };
}

function renderRegions(legacy: LegacyClusters, surface: "bar" | "sheet" = "bar") {
	return render(
		<I18nProvider>
			<TaskHeaderProvider value={{ scope: { task, project, dispatch: vi.fn(), navigate: vi.fn() }, legacy }}>
				{TASK_HEADER_REGIONS.map((region) => (
					<div key={region} data-testid={`bar-${region}`}>
						<TaskHeaderRegionItems region={region} surface={surface} />
					</div>
				))}
			</TaskHeaderProvider>
		</I18nProvider>,
	);
}

beforeEach(() => {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);
});

describe("taskHeader slot", () => {
	it("registers one built-in legacy cluster per region, in its own region", () => {
		const registry = getTaskHeaderRegistry();
		expect(registry.kind).toBe("contribute");
		for (const region of TASK_HEADER_REGIONS) {
			expect(registry.listRegion(region).map((entry) => entry.def.id)).toEqual([legacyClusterId(region)]);
		}
	});

	it("renders each region's cluster inside its own bar, for the surface asked", () => {
		renderRegions(clusters("bar"));
		for (const region of TASK_HEADER_REGIONS) {
			expect(screen.getByTestId(`bar-${region}`)).toContainElement(screen.getByTestId(`legacy-${region}-bar`));
		}
	});

	it("renders the sheet form on the narrow sheet, and nothing for a region without one", () => {
		const legacy = clusters("sheet");
		legacy.session = {};
		renderRegions(legacy, "sheet");
		expect(screen.getByTestId("legacy-status-sheet")).toBeInTheDocument();
		expect(screen.queryByText("session")).toBeNull();
		expect(screen.getByTestId("bar-session").textContent).toBe("");
	});

	it("lays the region out as children of the host's bar (display: contents)", () => {
		renderRegions(clusters("bar"));
		const wrapper = screen.getByTestId("bar-git").firstElementChild as HTMLElement;
		expect(wrapper.dataset.region).toBe("git");
		expect(wrapper.className).toBe("contents");
	});

	it("isolates a crashing item: its bar and the other bars keep rendering", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		function Crash(): never {
			throw new Error("boom");
		}
		const fiber: Fiber = getAppRoot().plugin({
			name: "crashing-item",
			inject: ["taskHeader"],
			apply(ctx: Context) {
				ctx.taskHeader.register({ id: "builtin:git.crash-test", region: "git", order: -1, component: Crash });
			},
		});
		await act(async () => {
			await fiber;
		});
		renderRegions(clusters("bar"));
		for (const region of TASK_HEADER_REGIONS) expect(screen.getByTestId(`legacy-${region}-bar`)).toBeInTheDocument();
		expect(error.mock.calls.some((call) => String(call[0]).includes("builtin:git.crash-test crashed"))).toBe(true);
		error.mockRestore();
	});
});
