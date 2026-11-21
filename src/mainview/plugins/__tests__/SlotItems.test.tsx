import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { Context, type Fiber } from "cordis";
import { I18nProvider } from "../../i18n";
import { SlotRegistry } from "../slot-registry";
import { foldBudget, SlotItems, useFoldBudget, type ContributionSlotItem, type SlotItemProps } from "../SlotItems";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

interface Scope {
	hasPr: boolean;
}
type Item = ContributionSlotItem<Scope>;

declare module "cordis" {
	interface Context {
		itemsTestSlot: SlotRegistry<Item>;
	}
}

function Button({ label }: { label: string }) {
	return function ItemButton({ placement }: SlotItemProps) {
		return placement === "inline"
			? <button type="button">{label}</button>
			: <button type="button" role="menuitem">{label} (menu)</button>;
	};
}

let root: Context;
let registry: SlotRegistry<Item>;

beforeEach(() => {
	root = new Context();
	registry = new SlotRegistry<Item>(root, "itemsTestSlot", { kind: "contribute", noun: "test item" });
});

async function plugin(name: string, items: Array<Partial<Item> & { id: string }>): Promise<Fiber> {
	const fiber = root.plugin({
		name,
		inject: ["itemsTestSlot"],
		apply(ctx: Context) {
			for (const item of items) ctx.itemsTestSlot.register({ component: Button({ label: item.id }), ...item });
		},
	});
	return await act(async () => await fiber);
}

function renderItems(props: { scope?: Scope; budget?: number; region?: string } = {}) {
	const ui = (p: typeof props) => (
		<I18nProvider>
			<SlotItems registry={registry} scope={p.scope ?? { hasPr: false }} budget={p.budget} region={p.region} />
		</I18nProvider>
	);
	const result = render(ui(props));
	return { ...result, rerenderWith: (next: typeof props) => result.rerender(ui(next)) };
}

const inlineLabels = () => screen.queryAllByRole("button").map((b) => b.textContent).filter((text) => text !== "");

describe("SlotItems", () => {
	it("renders items by order, ties in registration order", async () => {
		await plugin("p", [{ id: "c", order: 5 }, { id: "a" }, { id: "b", order: -1 }, { id: "d", order: 5 }]);
		renderItems();
		expect(inlineLabels()).toEqual(["b", "a", "c", "d"]);
	});

	it("shows one region only when asked", async () => {
		await plugin("p", [{ id: "l", region: "left" }, { id: "r", region: "right" }]);
		renderItems({ region: "right" });
		expect(inlineLabels()).toEqual(["r"]);
	});

	it("picks up items registered after mount", async () => {
		renderItems();
		expect(inlineLabels()).toEqual([]);
		await plugin("late", [{ id: "late" }]);
		expect(inlineLabels()).toEqual(["late"]);
	});

	it("puts items past the budget under More, rendered as menu rows, and closes after a row acts", async () => {
		await plugin("p", [{ id: "one" }, { id: "two" }, { id: "three" }, { id: "four" }]);
		renderItems({ budget: 2 });
		const more = screen.getByRole("button", { name: "More" });
		expect(screen.getByRole("button", { name: "one" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "two" })).toBeTruthy();
		expect(screen.queryByText("three")).toBeNull();
		expect(more.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(more);
		const menu = screen.getByRole("menu");
		expect(more.getAttribute("aria-expanded")).toBe("true");
		expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((row) => row.textContent)).toEqual(["three (menu)", "four (menu)"]);

		fireEvent.click(screen.getByRole("menuitem", { name: "three (menu)" }));
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("shows no More button when everything fits", async () => {
		await plugin("p", [{ id: "one" }, { id: "two" }]);
		renderItems({ budget: 2 });
		expect(screen.queryByRole("button", { name: "More" })).toBeNull();
	});

	it("folds everything under More with a zero budget", async () => {
		await plugin("p", [{ id: "one" }]);
		renderItems({ budget: 0 });
		expect(screen.queryByRole("button", { name: "one" })).toBeNull();
		expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
	});

	it("isolates a crashing item: its neighbours still render", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Boom = () => {
			throw new Error("boom");
		};
		await plugin("good", [{ id: "before", order: 1 }, { id: "after", order: 3 }]);
		await plugin("bad", [{ id: "bad:item", order: 2, component: Boom }]);
		renderItems();
		expect(inlineLabels()).toEqual(["before", "after"]);
		expect(errors.mock.calls.some((call) => String(call[0]).includes("bad:item"))).toBe(true);
		errors.mockRestore();
	});

	it("re-evaluates when() as the scope changes, and hides an item whose when() throws", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await plugin("p", [
			{ id: "always" },
			{ id: "pr", when: (scope) => scope.hasPr },
			{ id: "broken", when: () => { throw new Error("nope"); } },
		]);
		const { rerenderWith } = renderItems({ scope: { hasPr: false } });
		expect(inlineLabels()).toEqual(["always"]);
		rerenderWith({ scope: { hasPr: true } });
		expect(inlineLabels()).toEqual(["always", "pr"]);
		rerenderWith({ scope: { hasPr: false } });
		expect(inlineLabels()).toEqual(["always"]);
		errors.mockRestore();
	});

	it("counts the budget after when(), so a hidden item frees its slot", async () => {
		await plugin("p", [{ id: "hidden", when: () => false }, { id: "one" }, { id: "two" }]);
		renderItems({ budget: 2 });
		expect(inlineLabels()).toEqual(["one", "two"]);
		expect(screen.queryByRole("button", { name: "More" })).toBeNull();
	});

	it("removes a plugin's items when the plugin is disposed", async () => {
		const fiber = await plugin("gone", [{ id: "gone" }]);
		await plugin("stays", [{ id: "stays" }]);
		renderItems();
		expect(inlineLabels()).toEqual(["gone", "stays"]);
		await act(async () => {
			await fiber.dispose();
		});
		await waitFor(() => expect(inlineLabels()).toEqual(["stays"]));
	});
});

describe("folding by container width", () => {
	it("computes how many items fit", () => {
		expect(foldBudget(300, { itemWidth: 100 })).toBe(3);
		expect(foldBudget(300, { itemWidth: 100, reserve: 40 })).toBe(2);
		expect(foldBudget(1000, { itemWidth: 100, max: 4 })).toBe(4);
		expect(foldBudget(20, { itemWidth: 100, reserve: 40 })).toBe(0);
	});

	it("follows the container as it resizes", () => {
		let width = 400;
		let notify: (() => void) | null = null;
		const original = globalThis.ResizeObserver;
		globalThis.ResizeObserver = class {
			constructor(cb: () => void) {
				notify = cb;
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
		const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);

		function Probe() {
			const ref = useRef<HTMLDivElement>(null);
			const budget = useFoldBudget(ref, { itemWidth: 100, reserve: 40, max: 5 });
			return <div ref={ref} data-testid="probe">{String(budget)}</div>;
		}
		render(<Probe />);
		expect(screen.getByTestId("probe").textContent).toBe("3");
		width = 150;
		act(() => notify!());
		expect(screen.getByTestId("probe").textContent).toBe("1");

		clientWidth.mockRestore();
		globalThis.ResizeObserver = original;
	});
});
