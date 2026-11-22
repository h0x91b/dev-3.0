import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Context, Fiber } from "cordis";
import { getAppRoot, observeAppSlots } from "../root";
import { resetPluginsForTests } from "../runtime";
import type { SlotItem, SlotRegistry } from "../slot-registry";
import { importAppSlots, MAINVIEW, sourceFiles } from "./app-slots";

/**
 * Every slot on the app root, and the test that unloads a contributor on that slot's own surface.
 * A slot missing here fails the suite: a new slot ships with its surface-level `[dispose]` test.
 */
const SURFACE_DISPOSE_TESTS: Record<string, string> = {
	boardViews: "board-views/__tests__/BoardHost.test.tsx",
	commands: "components/__tests__/CommandPaletteModal.test.tsx",
	destinationBodies: "destination-bodies/__tests__/destination-body.test.tsx",
	fileMenu: "file-menu/__tests__/file-menu-slot.test.tsx",
	goToSources: "go-to-sources/__tests__/go-to-sources.test.tsx",
	settingsSections: "settings-sections/__tests__/settings-sections.test.tsx",
	sidebar: "sidebar/__tests__/sidebar-slot.test.tsx",
	taskHeader: "task-header/__tests__/task-header-slot.test.tsx",
	taskMarkers: "task-markers/__tests__/task-markers.test.tsx",
	taskMenu: "task-menu/__tests__/task-menu-slot.test.tsx",
	taskPanels: "task-panels/__tests__/task-panels.test.tsx",
	terminalCompanion: "terminal-companion/__tests__/terminal-companion.test.tsx",
	terminalLinks: "terminal-links/__tests__/terminal-links.test.ts",
	terminalTabDecorations: "components/__tests__/TerminalWindowNav.test.tsx",
	terminalWindowMenu: "components/__tests__/TerminalWindowNav.test.tsx",
	tips: "tips/__tests__/tips-slot.test.tsx",
};

type AnySlot = SlotRegistry<SlotItem>;

let slots: Map<string, AnySlot>;

beforeAll(importAppSlots, 30_000);

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
		// A convention check: the mapped file has a live `[dispose]` test, not proof it targets this slot.
		const liveDisposeTest = /^\s*it(\.each\(.*?\))?\(\s*["'`][^"'`]*\[dispose\]/m;
		for (const [slot, file] of Object.entries(SURFACE_DISPOSE_TESTS)) {
			const text = readFileSync(join(MAINVIEW, file), "utf8");
			expect(text, `${file} has no [dispose] test for ${slot}`).toMatch(liveDisposeTest);
		}
	});

	it("sees defineAppSlot only imported by its own name and called, never renamed, re-exported or passed around", () => {
		const offenders = sourceFiles()
			.filter((file) => !file.endsWith(join("plugins", "root.ts")))
			.filter((file) => {
				const text = readFileSync(file, "utf8");
				const rest = text
					.replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*root["']/g, (decl) =>
						/\bdefineAppSlot\s+as\b/.test(decl) ? decl : decl.replace(/\bdefineAppSlot\b/g, ""),
					)
					.replace(/\bdefineAppSlot\s*(<[^>]*>)?\s*\(/g, "");
				return /\bdefineAppSlot\b/.test(rest) || /export\s*\*\s*from\s*["'][^"']*plugins\/root["']/.test(text);
			})
			.map((file) => relative(MAINVIEW, file));
		expect(offenders).toEqual([]);
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
