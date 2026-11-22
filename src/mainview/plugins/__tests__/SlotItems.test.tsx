import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { Context, type Fiber } from "cordis";
import { I18nProvider } from "../../i18n";
import { SlotRegistry } from "../slot-registry";
import {
	foldBudget,
	placeSlotItems,
	SlotItems,
	useFoldBudget,
	type ContributionSlotItem,
	type SlotItemMenuRequest,
	type SlotItemProps,
	type SlotUserLayout,
} from "../SlotItems";

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

/** Inline: a plain button. In More: a proper menu row. */
function Button({ label }: { label: string }) {
	return function ItemButton({ placement }: SlotItemProps) {
		return placement === "inline"
			? <button type="button">{label}</button>
			: <button type="button" role="menuitem">{label}</button>;
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

interface Props {
	scope?: Scope;
	budget?: number;
	region?: string;
	layout?: SlotUserLayout;
	onItemMenu?: (request: SlotItemMenuRequest) => void;
}

function renderItems(props: Props = {}) {
	const ui = (p: Props) => (
		<I18nProvider>
			<SlotItems registry={registry} scope={p.scope ?? { hasPr: false }} budget={p.budget} region={p.region} layout={p.layout} onItemMenu={p.onItemMenu} />
		</I18nProvider>
	);
	const result = render(ui(props));
	return { ...result, rerenderWith: (next: Props) => result.rerender(ui(next)) };
}

/** Labels drawn in the bar (the More trigger has no text). */
const inlineLabels = () => screen.queryAllByRole("button").map((b) => b.textContent).filter((text) => text !== "");
const more = () => screen.getByRole("button", { name: "More" });
const menuLabels = () => screen.getAllByRole("menuitem").map((row) => row.textContent);

describe("SlotItems: order and lifecycle", () => {
	it("renders built-ins by order, ties in registration order", async () => {
		await plugin("p", [{ id: "builtin:c", order: 5 }, { id: "builtin:a" }, { id: "builtin:b", order: -1 }, { id: "builtin:d", order: 5 }]);
		renderItems();
		expect(inlineLabels()).toEqual(["builtin:b", "builtin:a", "builtin:c", "builtin:d"]);
	});

	it("shows one region only when asked", async () => {
		await plugin("p", [{ id: "builtin:l", region: "left" }, { id: "builtin:r", region: "right" }]);
		renderItems({ region: "right" });
		expect(inlineLabels()).toEqual(["builtin:r"]);
	});

	it("picks up items registered after mount", async () => {
		renderItems();
		expect(inlineLabels()).toEqual([]);
		await plugin("late", [{ id: "builtin:late" }]);
		expect(inlineLabels()).toEqual(["builtin:late"]);
	});

	it("isolates a crashing item: its neighbours still render", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Boom = () => {
			throw new Error("boom");
		};
		await plugin("good", [{ id: "builtin:before", order: 1 }, { id: "builtin:after", order: 3 }]);
		await plugin("bad", [{ id: "builtin:bad", order: 2, component: Boom }]);
		renderItems();
		expect(inlineLabels()).toEqual(["builtin:before", "builtin:after"]);
		expect(errors.mock.calls.some((call) => String(call[0]).includes("builtin:bad"))).toBe(true);
		errors.mockRestore();
	});

	it("re-evaluates when() as the scope changes, and hides an item whose when() throws", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await plugin("p", [
			{ id: "builtin:always" },
			{ id: "builtin:pr", when: (scope) => scope.hasPr },
			{ id: "builtin:broken", when: () => { throw new Error("nope"); } },
		]);
		const { rerenderWith } = renderItems({ scope: { hasPr: false } });
		expect(inlineLabels()).toEqual(["builtin:always"]);
		rerenderWith({ scope: { hasPr: true } });
		expect(inlineLabels()).toEqual(["builtin:always", "builtin:pr"]);
		rerenderWith({ scope: { hasPr: false } });
		expect(inlineLabels()).toEqual(["builtin:always"]);
		errors.mockRestore();
	});

	it("removes a plugin's items when the plugin is disposed", async () => {
		const fiber = await plugin("gone", [{ id: "builtin:gone" }]);
		await plugin("stays", [{ id: "builtin:stays" }]);
		renderItems();
		expect(inlineLabels()).toEqual(["builtin:gone", "builtin:stays"]);
		await act(async () => {
			await fiber.dispose();
		});
		await waitFor(() => expect(inlineLabels()).toEqual(["builtin:stays"]));
	});
});

describe("SlotItems: placement by origin (bible §5.1, §5.12)", () => {
	it("never budgets or folds a built-in, even past the budget", async () => {
		await plugin("p", [{ id: "builtin:1" }, { id: "builtin:2" }, { id: "builtin:3" }, { id: "builtin:4" }, { id: "builtin:5" }]);
		renderItems({ budget: 2 });
		expect(inlineLabels()).toEqual(["builtin:1", "builtin:2", "builtin:3", "builtin:4", "builtin:5"]);
		expect(screen.queryByRole("button", { name: "More" })).toBeNull();
	});

	it("starts extension items in More", async () => {
		await plugin("builtins", [{ id: "builtin:a" }]);
		await plugin("ext", [{ id: "ext:x" }]);
		renderItems();
		expect(inlineLabels()).toEqual(["builtin:a"]);
		fireEvent.click(more());
		expect(menuLabels()).toEqual(["ext:x"]);
	});

	it("brings a pinned extension item into the bar, after the built-ins, within the room they leave", async () => {
		await plugin("builtins", [{ id: "builtin:a" }, { id: "builtin:b" }]);
		await plugin("ext", [{ id: "ext:x" }, { id: "ext:y" }, { id: "ext:z" }]);
		renderItems({ budget: 3, layout: { pinned: ["ext:x", "ext:y"] } });
		expect(inlineLabels()).toEqual(["builtin:a", "builtin:b", "ext:x"]);
		fireEvent.click(more());
		expect(menuLabels()).toEqual(["ext:y", "ext:z"]);
	});

	it("puts anything the user sent to More there, built-ins included, and honours the user's order", async () => {
		await plugin("builtins", [{ id: "builtin:a" }, { id: "builtin:b" }, { id: "builtin:c" }]);
		await plugin("ext", [{ id: "ext:x" }]);
		renderItems({ layout: { overflow: ["builtin:b"], pinned: ["ext:x"], order: ["ext:x", "builtin:c"] } });
		expect(inlineLabels()).toEqual(["ext:x", "builtin:c", "builtin:a"]);
		fireEvent.click(more());
		expect(menuLabels()).toEqual(["builtin:b"]);
	});

	it("counts the room after when(), so a hidden built-in frees it", async () => {
		await plugin("builtins", [{ id: "builtin:hidden", when: () => false }, { id: "builtin:a" }]);
		await plugin("ext", [{ id: "ext:x" }]);
		renderItems({ budget: 2, layout: { pinned: ["ext:x"] } });
		expect(inlineLabels()).toEqual(["builtin:a", "ext:x"]);
		expect(screen.queryByRole("button", { name: "More" })).toBeNull();
	});

	it("places by origin in the pure helper too", () => {
		const e = (id: string) => ({ def: { id } });
		const { inline, overflow } = placeSlotItems([e("ext:1"), e("builtin:a"), e("ext:2")], { pinned: ["ext:2"] }, 1);
		expect(inline.map((x) => x.def.id)).toEqual(["builtin:a"]);
		expect(overflow.map((x) => x.def.id)).toEqual(["ext:1", "ext:2"]);
	});

	it("leaves the budget to pinned extensions when the host exempts a built-in from it", () => {
		const e = (id: string) => ({ def: { id } });
		const entries = [e("builtin:a"), e("builtin:composite"), e("ext:1")];
		const layout = { pinned: ["ext:1"] };
		expect(placeSlotItems(entries, layout, 2).inline.map((x) => x.def.id)).toEqual(["builtin:a", "builtin:composite"]);
		expect(placeSlotItems(entries, layout, 2, new Set(["builtin:composite"])).inline.map((x) => x.def.id))
			.toEqual(["builtin:a", "builtin:composite", "ext:1"]);
	});
});

describe("SlotItems: the user's layout and the item menu", () => {
	const Nothing = () => null;

	it("drops what the user hid", async () => {
		await plugin("builtins", [{ id: "builtin:a" }, { id: "builtin:b" }]);
		renderItems({ layout: { hidden: ["builtin:a"] } });
		expect(inlineLabels()).toEqual(["builtin:b"]);
	});

	it("counts only built-ins that draw something once it can measure them", async () => {
		await plugin("builtins", [{ id: "builtin:a" }, { id: "builtin:silent-1", component: Nothing }, { id: "builtin:silent-2", component: Nothing }]);
		await plugin("ext", [{ id: "ext:x" }]);
		const layout = { pinned: ["ext:x"] };
		const { unmount } = renderItems({ budget: 2, layout });
		// Without a host menu nothing is measured: every registered built-in counts.
		expect(inlineLabels()).toEqual(["builtin:a"]);
		unmount();
		renderItems({ budget: 2, layout, onItemMenu: vi.fn() });
		expect(inlineLabels()).toEqual(["builtin:a", "ext:x"]);
	});

	it("opens the host menu on right-click with the region as drawn", async () => {
		await plugin("builtins", [{ id: "builtin:a" }, { id: "builtin:silent", component: Nothing }, { id: "builtin:b" }]);
		await plugin("ext", [{ id: "ext:x" }]);
		const onItemMenu = vi.fn();
		renderItems({ budget: 4, onItemMenu, layout: { hidden: ["builtin:b"] } });
		fireEvent.contextMenu(screen.getByRole("button", { name: "builtin:a" }), { clientX: 30, clientY: 40 });
		const request: SlotItemMenuRequest = onItemMenu.mock.calls[0][0];
		expect(request).toMatchObject({ id: "builtin:a", placement: "inline", at: { top: 40, left: 30 }, drawn: ["builtin:a"], overflow: ["ext:x"], room: 3 });
		expect(request.order).toEqual(["builtin:a", "builtin:silent", "builtin:b", "ext:x"]);
	});

	it("opens it from a More row too, and from the keyboard's menu key under the control", async () => {
		await plugin("builtins", [{ id: "builtin:a" }]);
		await plugin("ext", [{ id: "ext:x" }]);
		const onItemMenu = vi.fn();
		renderItems({ onItemMenu });
		fireEvent.click(more());
		fireEvent.contextMenu(screen.getByRole("menuitem", { name: "ext:x" }), { clientX: 0, clientY: 0 });
		expect(onItemMenu.mock.calls[0][0]).toMatchObject({ id: "ext:x", placement: "overflow" });
		expect(onItemMenu.mock.calls[0][0].returnFocus).toBe(more());
	});

	it("opens it on Shift+F10 and the Menu key itself, where the browser fires no contextmenu", async () => {
		await plugin("builtins", [{ id: "builtin:a" }]);
		await plugin("ext", [{ id: "ext:x" }]);
		const onItemMenu = vi.fn();
		renderItems({ onItemMenu });
		const button = screen.getByRole("button", { name: "builtin:a" });
		fireEvent.keyDown(button, { key: "F10" });
		fireEvent.keyDown(button, { key: "F10", shiftKey: true, metaKey: true });
		expect(onItemMenu).not.toHaveBeenCalled();
		fireEvent.keyDown(button, { key: "F10", shiftKey: true });
		expect(onItemMenu.mock.calls[0][0]).toMatchObject({ id: "builtin:a", placement: "inline" });
		expect(onItemMenu.mock.calls[0][0].returnFocus).toBe(button);
		expect(onItemMenu.mock.calls[0][0].host).toBe(document.querySelector("[data-slot]"));
		fireEvent.click(more());
		fireEvent.keyDown(screen.getByRole("menuitem", { name: "ext:x" }), { key: "ContextMenu" });
		expect(onItemMenu.mock.calls[1][0]).toMatchObject({ id: "ext:x", placement: "overflow" });
		expect(onItemMenu.mock.calls[1][0].returnFocus).toBe(more());
	});

	it("opens it on a touch long-press and swallows the tap that ends the press", async () => {
		vi.useFakeTimers();
		try {
			const clicked = vi.fn();
			await plugin("builtins", [{ id: "builtin:a", component: () => <button type="button" onClick={clicked}>builtin:a</button> }]);
			const onItemMenu = vi.fn();
			renderItems({ onItemMenu });
			const button = screen.getByRole("button", { name: "builtin:a" });
			fireEvent.pointerDown(button, { pointerType: "touch", clientX: 5, clientY: 6 });
			act(() => {
				vi.advanceTimersByTime(600);
			});
			// The lift click lands on whatever the menu put under the finger, e.g. its backdrop.
			const backdrop = document.body.appendChild(document.createElement("div"));
			const backdropClicked = vi.fn();
			backdrop.addEventListener("click", backdropClicked);
			fireEvent.pointerUp(button, { pointerType: "touch" });
			fireEvent.click(backdrop);
			expect(onItemMenu).toHaveBeenCalledOnce();
			expect(backdropClicked).not.toHaveBeenCalled();
			fireEvent.click(button);
			expect(clicked).toHaveBeenCalledOnce();
			backdrop.remove();
		} finally {
			vi.useRealTimers();
		}
	});

	it("lets the next tap through when the browser sent no lift click", async () => {
		vi.useFakeTimers();
		try {
			const clicked = vi.fn();
			await plugin("builtins", [{ id: "builtin:a", component: () => <button type="button" onClick={clicked}>builtin:a</button> }]);
			renderItems({ onItemMenu: vi.fn() });
			const button = screen.getByRole("button", { name: "builtin:a" });
			fireEvent.pointerDown(button, { pointerType: "touch" });
			act(() => {
				vi.advanceTimersByTime(600);
			});
			fireEvent.pointerUp(button, { pointerType: "touch" });
			fireEvent.pointerDown(button, { pointerType: "touch" });
			fireEvent.pointerUp(button, { pointerType: "touch" });
			fireEvent.click(button);
			expect(clicked).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("SlotItems: the More menu", () => {
	beforeEach(async () => {
		await plugin("builtins", [{ id: "builtin:a" }]);
		await plugin("ext", [{ id: "ext:one" }, { id: "ext:two" }, { id: "ext:three" }]);
	});

	it("moves focus into the panel only once it is visible", () => {
		const seen: string[] = [];
		const original = HTMLElement.prototype.focus;
		const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
			const menu = this.closest<HTMLElement>('[role="menu"]');
			if (menu) seen.push(menu.style.visibility);
			original.call(this, options);
		});
		try {
			renderItems();
			fireEvent.click(more());
			expect(seen.length).toBeGreaterThan(0);
			expect(seen).not.toContain("hidden");
		} finally {
			spy.mockRestore();
		}
	});

	it("is a menu: focus lands on the first row, arrows/Home/End move, Escape returns to the trigger", () => {
		renderItems();
		const trigger = more();
		expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(trigger);
		const menu = screen.getByRole("menu");
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement?.textContent).toBe("ext:one");

		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement?.textContent).toBe("ext:two");
		fireEvent.keyDown(menu, { key: "End" });
		expect(document.activeElement?.textContent).toBe("ext:three");
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement?.textContent).toBe("ext:one");
		fireEvent.keyDown(menu, { key: "ArrowUp" });
		expect(document.activeElement?.textContent).toBe("ext:three");
		fireEvent.keyDown(menu, { key: "Home" });
		expect(document.activeElement?.textContent).toBe("ext:one");

		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("opens from the keyboard with ArrowDown on the trigger", () => {
		renderItems();
		fireEvent.keyDown(more(), { key: "ArrowDown" });
		expect(screen.getByRole("menu")).toBeTruthy();
		expect(document.activeElement?.textContent).toBe("ext:one");
	});

	it("closes after a row acts and gives focus back to the trigger", () => {
		renderItems();
		fireEvent.click(more());
		const row = screen.getByRole("menuitem", { name: "ext:two" });
		row.focus();
		fireEvent.click(row);
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(more());
	});

	it("warns when an item renders no menuitem in More", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await plugin("lazy", [{ id: "ext:plain", component: () => <span>plain</span> }]);
		renderItems();
		fireEvent.click(more());
		expect(warn.mock.calls.some((call) => String(call[0]).includes("ext:plain"))).toBe(true);
		warn.mockRestore();
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
		try {
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
		} finally {
			clientWidth.mockRestore();
			globalThis.ResizeObserver = original;
		}
	});
});
