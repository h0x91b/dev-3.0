import { act, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import type { Task } from "../../../shared/types";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { resetPluginsForTests } from "../../plugins/runtime";
import type { SlotEntry } from "../../plugins/slot-registry";
import { BUILTIN_TASK_MARKERS } from "../builtins";
import { getTaskMarkerRegistry, labelTaskMarkers, placeTaskMarkers, type TaskMarkerItem, type TaskMarkerScope } from "../registry";
import type { TFunction } from "../../i18n";
import { TaskMarkers, TaskMarkersProvider } from "../TaskMarkers";
import { installTaskMarkerBuiltins } from "./install-builtins";

function task(overrides: Partial<Task> = {}): Task {
	return { id: "t1", seq: 1, title: "A task", status: "in-progress", ...overrides } as Task;
}

function marker(id: string, overrides: Partial<TaskMarkerItem> = {}): TaskMarkerItem {
	return {
		id,
		when: () => true,
		label: () => id,
		component: () => <span data-testid={`marker-${id}`} />,
		...overrides,
	};
}

function entry(def: TaskMarkerItem): SlotEntry<TaskMarkerItem> {
	return { def, ctx: getAppRoot() };
}

const card = (overrides: Partial<Task> = {}): TaskMarkerScope => ({ task: task(overrides), surface: "card" });

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function registerFrom(name: string, defs: TaskMarkerItem[]) {
	getAppRoot().plugin({
		name,
		inject: ["taskMarkers"],
		apply(ctx: Context) {
			for (const def of defs) ctx.taskMarkers.register(def);
		},
	});
}

beforeEach(() => resetPluginsForTests());

describe("placeTaskMarkers", () => {
	it("shows every applicable built-in, then at most one extension marker", () => {
		const entries = [
			entry(marker("ext:a")),
			entry(marker("builtin:one")),
			entry(marker("ext:b")),
			entry(marker("builtin:two")),
		];
		expect(placeTaskMarkers(entries, card()).map((e) => e.def.id)).toEqual(["builtin:one", "builtin:two", "ext:a"]);
	});

	it("gives the extension room to the first one that applies", () => {
		const entries = [entry(marker("ext:a", { when: () => false })), entry(marker("ext:b"))];
		expect(placeTaskMarkers(entries, card()).map((e) => e.def.id)).toEqual(["ext:b"]);
	});

	it("keeps a marker to its surfaces and hides one whose when() throws", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const entries = [
			entry(marker("builtin:card-only", { surfaces: ["card"] })),
			entry(marker("builtin:broken", { when: () => { throw new Error("boom"); } })),
		];
		expect(placeTaskMarkers(entries, card()).map((e) => e.def.id)).toEqual(["builtin:card-only"]);
		expect(placeTaskMarkers(entries, { ...card(), surface: "sidebar" })).toEqual([]);
		errors.mockRestore();
	});

	it("reports a throwing when() once per marker, not once per card per render", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const entries = [entry(marker("builtin:noisy-when", { when: () => { throw new Error("boom"); } }))];
		for (let i = 0; i < 100; i++) placeTaskMarkers(entries, card({ id: `t${i}` }));
		expect(errors.mock.calls.filter((call) => String(call[0]).includes("builtin:noisy-when"))).toHaveLength(1);
		errors.mockRestore();
	});

	it("drops a marker whose label() throws, keeps the rest, and reports it once", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const entries = [
			entry(marker("builtin:ok")),
			entry(marker("builtin:noisy-label", { label: () => { throw new Error("boom"); } })),
		];
		const t = ((key: string) => key) as TFunction;
		for (let i = 0; i < 100; i++) {
			const labelled = labelTaskMarkers(entries, t, card({ id: `t${i}` }));
			expect(labelled.map((m) => [m.entry.def.id, m.label])).toEqual([["builtin:ok", "builtin:ok"]]);
		}
		expect(errors.mock.calls.filter((call) => String(call[0]).includes("builtin:noisy-label"))).toHaveLength(1);
		errors.mockRestore();
	});

	it("applies the built-ins exactly where the old inline glyphs rendered", () => {
		const entries = BUILTIN_TASK_MARKERS.map(entry);
		const ids = (scope: TaskMarkerScope) => placeTaskMarkers(entries, scope).map((e) => e.def.id);
		const both = { terminalBackend: "native", foreignCode: true } as Partial<Task>;
		expect(ids(card(both))).toEqual(["builtin:marker.native-backend", "builtin:marker.foreign-code"]);
		expect(ids({ task: task(both), surface: "sidebar" })).toEqual(["builtin:marker.native-backend"]);
		expect(ids(card({ terminalBackend: "tmux" }))).toEqual([]);
		expect(ids(card())).toEqual([]);
	});
});

describe("TaskMarkers", () => {
	it("draws the markers straight into the host's row, with no wrapper element", async () => {
		await installTaskMarkerBuiltins();
		const { container } = render(
			<I18nProvider>
				<div data-testid="row">
					<TaskMarkers task={task({ terminalBackend: "native", foreignCode: true })} surface="card" />
				</div>
			</I18nProvider>,
		);
		const row = screen.getByTestId("row");
		expect(screen.getByTestId("task-card-native-backend")).toHaveAttribute("aria-label", "Native terminal backend");
		expect(screen.getByTestId("task-card-foreign-code")).toBeInTheDocument();
		// Each marker is the row's own child (through its tooltip trigger), as before the slot.
		expect([...row.children].every((child) => !child.hasAttribute("data-slot"))).toBe(true);
		expect(container.querySelector("[data-slot]")).toBeNull();
	});

	it("renders nothing for a task no marker applies to", async () => {
		await installTaskMarkerBuiltins();
		render(
			<I18nProvider>
				<div data-testid="row"><TaskMarkers task={task()} surface="card" /></div>
			</I18nProvider>,
		);
		expect(screen.getByTestId("row").innerHTML).toBe("");
	});

	it("drops only the marker that throws", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		registerFrom("markers", [
			marker("builtin:boom", { component: () => { throw new Error("boom"); } }),
			marker("builtin:fine"),
		]);
		await settle();
		render(<TaskMarkers task={task()} surface="card" />);
		expect(screen.getByTestId("marker-builtin:fine")).toBeInTheDocument();
		errors.mockRestore();
	});

	it("subscribes to the registry once, however many cards render, and follows it", async () => {
		const registry = getTaskMarkerRegistry();
		const subscribe = vi.spyOn(registry, "subscribe");
		render(
			<TaskMarkersProvider>
				{Array.from({ length: 50 }, (_, i) => <TaskMarkers key={i} task={task({ id: `t${i}` })} surface="card" />)}
			</TaskMarkersProvider>,
		);
		expect(screen.queryAllByTestId("marker-builtin:late")).toHaveLength(0);
		registerFrom("late", [marker("builtin:late")]);
		await settle();
		expect(screen.getAllByTestId("marker-builtin:late")).toHaveLength(50);
		expect(subscribe).toHaveBeenCalledTimes(1);
	});
});
