import en from "../../i18n/translations/en";
import ru from "../../i18n/translations/ru";
import es from "../../i18n/translations/es";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { SIMPLIFY_VIEW_PRESET_IDS } from "../../hideable-controls";
import { BUILTIN_TASK_HEADER_PLUGIN } from "../builtins";
import { getTaskHeaderRegistry } from "../registry";
import { moveItem, regionLayout, sendToMore, showInBar, swapItems } from "../layout";
import { taskHeaderItemMenuEntries } from "../item-menu";
import type { SlotItemMenuRequest } from "../../plugins/SlotItems";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

beforeEach(() => {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_HEADER_PLUGIN]);
});

describe("task-header items as layout ids", () => {
	it("names every item in all three locales", () => {
		for (const { def } of getTaskHeaderRegistry().list()) {
			expect(en[def.label], def.id).toBeTruthy();
			expect(ru[def.label], def.id).toBeTruthy();
			expect(es[def.label], def.id).toBeTruthy();
		}
	});

	it("puts only registered items in the Simplify View preset", () => {
		const registry = getTaskHeaderRegistry();
		for (const id of SIMPLIFY_VIEW_PRESET_IDS.filter((value) => value.startsWith("builtin:"))) expect(registry.get(id), id).toBeDefined();
	});
});

describe("layout edits", () => {
	const order = ["builtin:a", "builtin:hidden-now", "builtin:b", "builtin:c"];
	const drawn = ["builtin:a", "builtin:b", "builtin:c"];

	it("moves one step among what is drawn, keeping undrawn items where they were", () => {
		expect(moveItem({}, "git", order, drawn, "builtin:b", -1).order).toEqual({ git: ["builtin:b", "builtin:a", "builtin:hidden-now", "builtin:c"] });
		expect(moveItem({}, "git", order, drawn, "builtin:a", 1).order).toEqual({ git: ["builtin:hidden-now", "builtin:b", "builtin:a", "builtin:c"] });
	});

	it("does nothing past either end", () => {
		const layout = {};
		expect(moveItem(layout, "git", order, drawn, "builtin:a", -1)).toBe(layout);
		expect(moveItem(layout, "git", order, drawn, "builtin:c", 1)).toBe(layout);
	});

	it("keeps the other regions' order", () => {
		const layout = { order: { session: ["builtin:x"] } };
		expect(moveItem(layout, "git", order, drawn, "builtin:b", 1).order).toEqual({ session: ["builtin:x"], git: ["builtin:a", "builtin:hidden-now", "builtin:c", "builtin:b"] });
	});

	it("sends to More and back; an extension item needs a pin to leave More", () => {
		const inMore = sendToMore({ pinned: ["ext:x"] }, "ext:x");
		expect(inMore).toEqual({ overflow: ["ext:x"], pinned: undefined });
		expect(showInBar(inMore, "ext:x")).toEqual({ overflow: undefined, pinned: ["ext:x"] });
		expect(showInBar(sendToMore({}, "builtin:a"), "builtin:a")).toEqual({ overflow: undefined, pinned: undefined });
	});

	it("puts the replacement in the replaced item's place and out of More", () => {
		const layout = swapItems({ overflow: ["builtin:c"] }, "git", order, "builtin:a", "builtin:c");
		expect(layout.order).toEqual({ git: ["builtin:c", "builtin:a", "builtin:hidden-now", "builtin:b"] });
		expect(layout.overflow).toBeUndefined();
	});

	it("gives each region its own order and the shared More, pins and hidden set", () => {
		const layout = { order: { git: ["builtin:b"], session: ["builtin:z"] }, overflow: ["builtin:c"], pinned: ["ext:x"] };
		expect(regionLayout(layout, "git", new Set(["builtin:a"]))).toEqual({ order: ["builtin:b"], overflow: ["builtin:c"], pinned: ["ext:x"], hidden: ["builtin:a"] });
	});
});

describe("items that are never hidden (open-in, dev server, ports)", () => {
	const t = ((key: string) => key) as unknown as Parameters<typeof taskHeaderItemMenuEntries>[0];
	const request = (id: string, extra: Partial<SlotItemMenuRequest> = {}): SlotItemMenuRequest => ({
		id,
		placement: "inline",
		at: { top: 0, left: 0 },
		returnFocus: null,
		order: ["builtin:runtime.open-in", "builtin:runtime.ports", "builtin:runtime.images", "builtin:runtime.scripts"],
		drawn: ["builtin:runtime.open-in", "builtin:runtime.ports", "builtin:runtime.images", "builtin:runtime.scripts"],
		overflow: ["ext:x"],
		room: 0,
		...extra,
	});

	it("only move within their bar", () => {
		const rows = taskHeaderItemMenuEntries(t, "runtime", request("builtin:runtime.ports"), new Set());
		const state = Object.fromEntries(rows.map((row) => [row.key, !row.disabled]));
		expect(state).toEqual({ "move-left": true, "move-right": true, "move-to-more": false, "use-instead": false, hide: false });
	});

	it("are never offered for an extension to replace, nor are budget-exempt items", () => {
		const rows = taskHeaderItemMenuEntries(t, "runtime", request("ext:x", { placement: "overflow" }), new Set());
		expect(rows.find((row) => row.key === "use-instead")?.submenu?.map((row) => row.key)).toEqual(["builtin:runtime.scripts"]);
	});

	it("stay in the bar even when stored as hidden or in More", () => {
		const layout = regionLayout({ overflow: ["builtin:runtime.ports", "builtin:runtime.scripts"] }, "runtime", new Set(["builtin:runtime.dev-server", "builtin:runtime.images"]));
		expect(layout.overflow).toEqual(["builtin:runtime.scripts"]);
		expect(layout.hidden).toEqual(["builtin:runtime.images"]);
	});
});
