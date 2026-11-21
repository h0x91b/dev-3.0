import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Context, Fiber } from "cordis";
import { getAppRoot, observeAppSlots } from "../root";
import { resetPluginsForTests } from "../runtime";
import type { SlotItem, SlotRegistry } from "../slot-registry";

/**
 * Every slot on the app root, and the test that unloads a contributor on that slot's own surface.
 * A slot missing here fails the suite: a new slot ships with its surface-level `[dispose]` test.
 */
const SURFACE_DISPOSE_TESTS: Record<string, string> = {
	boardViews: "board-views/__tests__/BoardHost.test.tsx",
	commands: "components/__tests__/CommandPaletteModal.test.tsx",
	destinationBodies: "destination-bodies/__tests__/destination-body.test.tsx",
	settingsSections: "settings-sections/__tests__/settings-sections.test.tsx",
	sidebar: "sidebar/__tests__/sidebar-slot.test.tsx",
	taskHeader: "task-header/__tests__/task-header-slot.test.tsx",
	taskMarkers: "task-markers/__tests__/task-markers.test.tsx",
	taskMenu: "task-menu/__tests__/task-menu-slot.test.tsx",
	taskPanels: "task-panels/__tests__/task-panels.test.tsx",
	terminalCompanion: "terminal-companion/__tests__/terminal-companion.test.tsx",
};

const MAINVIEW = resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

/** The modules that define a slot: found by scanning, so a new one cannot be forgotten here. */
const SLOT_MODULES = sourceFiles(MAINVIEW).filter(
	(file) => !file.endsWith(join("plugins", "root.ts")) && readFileSync(file, "utf8").includes("defineAppSlot("),
);

type AnySlot = SlotRegistry<SlotItem>;

let slots: Map<string, AnySlot>;

beforeAll(async () => {
	await Promise.all(SLOT_MODULES.map((file) => import(file)));
});

beforeEach(() => {
	resetPluginsForTests();
	slots = new Map();
	getAppRoot();
	observeAppSlots((slot) => slots.set(slot.name, slot));
});

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await Promise.resolve();
}

/** A plugin, and a plugin nested inside it, both registering into `slot`. */
function contributor(slot: string, prefix: string): Fiber {
	const probe = (id: string): SlotItem & Record<string, unknown> => ({ id, region: "probe-region", component: () => null });
	return getAppRoot().plugin({
		name: `${prefix}-parent`,
		inject: [slot],
		apply(ctx: Context) {
			const registry = (ctx as unknown as Record<string, AnySlot>)[slot];
			registry.register(probe(`${prefix}:a`));
			registry.register(probe(`${prefix}:b`));
			ctx.plugin({
				name: `${prefix}-child`,
				inject: [slot],
				apply(child: Context) {
					(child as unknown as Record<string, AnySlot>)[slot].register(probe(`${prefix}:child`));
				},
			});
		},
	});
}

const ids = (slot: AnySlot) => slot.list().map((entry) => entry.def.id).sort();

describe("slot dispose", () => {
	it("knows every slot on the app root and where each one's surface-level dispose test lives", () => {
		expect([...slots.keys()].sort()).toEqual(Object.keys(SURFACE_DISPOSE_TESTS).sort());
		for (const [slot, file] of Object.entries(SURFACE_DISPOSE_TESTS)) {
			const text = readFileSync(join(MAINVIEW, file), "utf8");
			expect(text, `${relative(MAINVIEW, join(MAINVIEW, file))} has no [dispose] test for ${slot}`).toMatch(/it(\.each\([^)]*\))?\(\s*["'`][^"'`]*\[dispose\]/);
		}
	});

	it.each(Object.keys(SURFACE_DISPOSE_TESTS))("%s: unloading a plugin removes everything it and its sub-plugins registered, and nothing else", async (name) => {
		const slot = slots.get(name)!;
		const keeper = contributor(name, "keeper");
		const leaving = contributor(name, "leaving");
		await settle();
		expect(ids(slot)).toEqual(["keeper:a", "keeper:b", "keeper:child", "leaving:a", "leaving:b", "leaving:child"]);
		const regionBefore = slot.listRegion("probe-region");
		const notified = vi.fn();
		const unsubscribe = slot.subscribe(notified);

		await leaving.dispose();

		expect(ids(slot)).toEqual(["keeper:a", "keeper:b", "keeper:child"]);
		expect(slot.listRegion("probe-region").map((entry) => entry.def.id).sort()).toEqual(["keeper:a", "keeper:b", "keeper:child"]);
		expect(slot.listRegion("probe-region")).not.toBe(regionBefore);
		expect(notified).toHaveBeenCalled();
		unsubscribe();

		// The ids are free again: a reloaded plugin may take them back.
		contributor(name, "leaving");
		await settle();
		expect(ids(slot)).toHaveLength(6);
		await keeper.dispose();
	});
});
