import { Context, type Fiber } from "cordis";
import { SlotRegistry, type SlotItem, type SlotKind } from "../slot-registry";
import { BoardViewRegistry } from "../../board-views/registry";

interface TestItem extends SlotItem {
	label?: string;
}

declare module "cordis" {
	interface Context {
		testSlot: SlotRegistry<TestItem>;
	}
}

interface Case {
	title: string;
	kind: SlotKind;
	noun: string;
	name: "testSlot" | "boardViews";
	create(root: Context): SlotRegistry<TestItem>;
}

const view = { component: () => null, supportsNarrow: true, label: "x" };

const CASES: Case[] = [
	{
		title: "BoardViewRegistry",
		kind: "replace",
		noun: "board view",
		name: "boardViews",
		create: (root) => new BoardViewRegistry(root) as unknown as SlotRegistry<TestItem>,
	},
	{
		title: "a contribution slot",
		kind: "contribute",
		noun: "header item",
		name: "testSlot",
		create: (root) => new SlotRegistry<TestItem>(root, "testSlot", { kind: "contribute", noun: "header item" }),
	},
];

describe.each(CASES)("SlotRegistry contract: $title", ({ kind, noun, name, create }) => {
	let root: Context;
	let registry: SlotRegistry<TestItem>;

	beforeEach(() => {
		root = new Context();
		registry = create(root);
		refusals = [];
	});

	let refusals: string[];

	/** A plugin that registers `items` into the slot under test, through its own context. */
	async function plugin(pluginName: string, items: TestItem[]): Promise<Fiber> {
		const fiber = root.plugin({
			name: pluginName,
			inject: [name],
			apply(ctx: Context) {
				for (const item of items) {
					try {
						(ctx[name] as SlotRegistry<TestItem>).register({ ...view, ...item });
					} catch (err) {
						refusals.push((err as Error).message);
					}
				}
			},
		});
		return await fiber;
	}

	const ids = () => registry.list().map((entry) => entry.def.id);

	it("is provided on the root under its name and reports its kind", () => {
		expect(root[name]).toBeDefined();
		expect(registry.kind).toBe(kind);
		expect(registry.noun).toBe(noun);
	});

	it("lists, gets and notifies, with the registering plugin's context on the entry", async () => {
		const listener = vi.fn();
		registry.subscribe(listener);
		const fiber = await plugin("p1", [{ id: "p1:a" }, { id: "p1:b" }]);
		expect(ids()).toEqual(["p1:a", "p1:b"]);
		expect(registry.get("p1:a")?.ctx.fiber).toBe(fiber);
		expect(listener).toHaveBeenCalled();
	});

	it("keeps list() identity stable until something changes", async () => {
		await plugin("p1", [{ id: "p1:a" }]);
		const first = registry.list();
		expect(registry.list()).toBe(first);
		await plugin("p2", [{ id: "p2:a" }]);
		expect(registry.list()).not.toBe(first);
	});

	it("removes a plugin's entries when the plugin is disposed", async () => {
		const fiber = await plugin("p1", [{ id: "p1:a" }]);
		await plugin("p2", [{ id: "p2:a" }]);
		await fiber.dispose();
		expect(ids()).toEqual(["p2:a"]);
		expect(registry.get("p1:a")).toBeUndefined();
	});

	it("lets the first live registration win and tells onRefused who was refused", async () => {
		const refused = vi.fn();
		registry.onRefused(refused);
		const owner = await plugin("owner", [{ id: "shared" }]);
		const thief = await plugin("thief", [{ id: "shared" }]);
		expect(refused).toHaveBeenCalledTimes(1);
		expect(refused.mock.calls[0][0]).toBe("shared");
		expect(refused.mock.calls[0][1].fiber).toBe(thief);
		expect(registry.get("shared")?.ctx.fiber).toBe(owner);
		expect(refusals.map((m) => m.toLowerCase())).toEqual([`${noun} "shared" is already registered`]);
	});

	it("lets the owning plugin register its id again", async () => {
		await plugin("owner", [{ id: "same", label: "one" }, { id: "same", label: "two" }]);
		expect(refusals).toEqual([]);
		expect(registry.get("same")?.def.label).toBe("two");
		expect(ids()).toEqual(["same"]);
	});

	it("lets another plugin take an id once its owner is gone", async () => {
		const owner = await plugin("owner", [{ id: "shared" }]);
		await owner.dispose();
		const next = await plugin("next", [{ id: "shared" }]);
		expect(registry.get("shared")?.ctx.fiber).toBe(next);
	});

	it("sorts by order and keeps registration order for ties", async () => {
		await plugin("p", [
			{ id: "c", order: 10 },
			{ id: "a" },
			{ id: "b", order: -5 },
			{ id: "d" },
			{ id: "e", order: 10 },
		]);
		expect(ids()).toEqual(["b", "a", "d", "c", "e"]);
	});

	it("lists one region at a time, with a stable identity until something changes", async () => {
		await plugin("p", [
			{ id: "l1", region: "left" },
			{ id: "r1", region: "right", order: 2 },
			{ id: "r2", region: "right", order: 1 },
		]);
		const right = registry.listRegion("right");
		expect(right.map((entry) => entry.def.id)).toEqual(["r2", "r1"]);
		expect(registry.listRegion("right")).toBe(right);
		expect(registry.listRegion("nowhere")).toEqual([]);
		await plugin("q", [{ id: "l2", region: "left" }]);
		expect(registry.listRegion("right")).not.toBe(right);
		expect(registry.listRegion("left").map((entry) => entry.def.id)).toEqual(["l1", "l2"]);
	});
});
