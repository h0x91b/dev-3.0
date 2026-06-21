import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import HintOverlay from "../HintOverlay";

// Deterministic hints so we can drive multi-character typing without needing
// 27+ cards on screen. The real generator is covered by hintLabels.test.ts.
vi.mock("../../utils/hintLabels", () => ({
	DEFAULT_HINT_CHARS: "asdfghjklqwertyuiopzxcvbnm",
	generateHintStrings: (count: number) => ["fa", "fs", "fd"].slice(0, count),
	codeToHintChar: (code: string) => {
		const m = /^Key([A-Z])$/.exec(code);
		return m ? m[1].toLowerCase() : null;
	},
}));

function makeCard(id: string, top: number, parent: HTMLElement = document.body): HTMLElement {
	const el = document.createElement("div");
	el.setAttribute("data-hint-id", id);
	// happy-dom returns an all-zero rect by default, which our visibility filter
	// would reject — stub a real on-screen rect.
	el.getBoundingClientRect = () =>
		({ x: 0, y: top, top, left: 0, right: 120, bottom: top + 40, width: 120, height: 40, toJSON() {} }) as DOMRect;
	parent.appendChild(el);
	return el;
}

function renderOverlay() {
	const onExit = vi.fn();
	render(
		<I18nProvider>
			<HintOverlay onExit={onExit} />
		</I18nProvider>,
	);
	return { onExit };
}

// Hint chars are matched on `e.code` (layout-independent), so a single letter
// must be sent as its physical key code (e.g. "f" → "KeyF").
function press(ch: string) {
	fireEvent.keyDown(document.body, { key: ch, code: `Key${ch.toUpperCase()}` });
}

describe("HintOverlay", () => {
	beforeEach(() => {
		window.innerWidth = 1200;
		window.innerHeight = 800;
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("renders one hint label per visible task card", () => {
		makeCard("t1", 0);
		makeCard("t2", 60);
		makeCard("t3", 120);
		renderOverlay();
		const labels = screen.getAllByTestId("hint-label");
		expect(labels).toHaveLength(3);
		expect(labels.map((l) => l.getAttribute("data-hint")).sort()).toEqual(["fa", "fd", "fs"]);
	});

	it("exits immediately and renders nothing when there are no cards", () => {
		const { onExit } = renderOverlay();
		expect(onExit).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("hint-overlay")).toBeNull();
	});

	it("filters to matching hints as the user types a shared prefix", () => {
		makeCard("t1", 0);
		makeCard("t2", 60);
		makeCard("t3", 120);
		renderOverlay();
		press("f"); // prefix of all three
		expect(screen.getByTestId("hint-overlay").getAttribute("data-hint-typed")).toBe("f");
		expect(screen.getAllByTestId("hint-label")).toHaveLength(3);
	});

	it("commits when the typed string uniquely identifies a hint", () => {
		const t1 = makeCard("t1", 0); // hint "fa"
		const t2 = makeCard("t2", 60); // hint "fs"
		makeCard("t3", 120); // hint "fd"
		const click1 = vi.fn();
		const click2 = vi.fn();
		t1.addEventListener("click", click1);
		t2.addEventListener("click", click2);
		const { onExit } = renderOverlay();

		press("f");
		press("s"); // "fs" → t2
		expect(click2).toHaveBeenCalledTimes(1);
		expect(click1).not.toHaveBeenCalled();
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("backspace removes the last typed character", () => {
		makeCard("t1", 0);
		makeCard("t2", 60);
		makeCard("t3", 120);
		renderOverlay();
		press("f");
		expect(screen.getByTestId("hint-overlay").getAttribute("data-hint-typed")).toBe("f");
		fireEvent.keyDown(document.body, { key: "Backspace" });
		expect(screen.getByTestId("hint-overlay").getAttribute("data-hint-typed")).toBe("");
		expect(screen.getAllByTestId("hint-label")).toHaveLength(3);
	});

	it("ignores keys that match no hint", () => {
		makeCard("t1", 0);
		makeCard("t2", 60);
		renderOverlay();
		press("z"); // valid hint char, but no hint starts with it
		expect(screen.getByTestId("hint-overlay").getAttribute("data-hint-typed")).toBe("");
		expect(screen.getAllByTestId("hint-label")).toHaveLength(2);
	});

	it("Escape exits without committing", () => {
		const t1 = makeCard("t1", 0);
		const click1 = vi.fn();
		t1.addEventListener("click", click1);
		const { onExit } = renderOverlay();
		fireEvent.keyDown(document.body, { key: "Escape" });
		expect(onExit).toHaveBeenCalledTimes(1);
		expect(click1).not.toHaveBeenCalled();
	});

	it("skips card clones living inside a dialog/popover", () => {
		makeCard("t1", 0); // real board card
		// A stuck-preparation-style popover clone: same kind of node, but inside
		// a role="dialog" and with no navigation handler.
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		document.body.appendChild(dialog);
		makeCard("t2", 0, dialog);
		renderOverlay();
		const labels = screen.getAllByTestId("hint-label");
		expect(labels).toHaveLength(1);
		expect(labels[0].getAttribute("data-hint")).toBe("fa");
	});

	it("skips cards occluded at their badge anchor (e.g. behind a modal/header)", () => {
		const t1 = makeCard("t1", 0);
		makeCard("t2", 60);
		const cover = document.createElement("div"); // stands in for a modal backdrop / header
		document.body.appendChild(cover);
		const orig = document.elementFromPoint;
		// t1's anchor resolves to itself (visible); t2's resolves to the cover (occluded).
		document.elementFromPoint = ((_x: number, y: number) => (y >= 60 ? cover : t1)) as typeof document.elementFromPoint;
		try {
			renderOverlay();
			const labels = screen.getAllByTestId("hint-label");
			expect(labels).toHaveLength(1);
			expect(labels[0].getAttribute("data-hint")).toBe("fa");
		} finally {
			document.elementFromPoint = orig;
		}
	});

	it("does not click a target that detached before commit", () => {
		const t1 = makeCard("t1", 0);
		const click1 = vi.fn();
		t1.addEventListener("click", click1);
		const { onExit } = renderOverlay();
		t1.remove(); // card leaves the DOM while the overlay is open
		press("f");
		press("a"); // would commit t1
		expect(click1).not.toHaveBeenCalled();
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("repositions badges synchronously on scroll (no React re-render needed)", () => {
		const t1 = makeCard("t1", 0); // hint "fa", badge anchored at top 0 + 4
		renderOverlay();
		const label = screen.getByTestId("hint-label");
		expect(label.style.top).toBe("4px");

		// The card scrolls upward; the badge must follow on the scroll event alone,
		// without any state change driving a re-render.
		t1.getBoundingClientRect = () =>
			({ x: 0, y: -50, top: -50, left: 0, right: 120, bottom: -10, width: 120, height: 40, toJSON() {} }) as DOMRect;
		fireEvent.scroll(window);
		expect(label.style.top).toBe("-46px");
	});

	it("hints heterogeneous targets (project rows + task rows) and ignores elements without data-hint-id", () => {
		makeCard("project:p1", 0);
		makeCard("task:t1", 60);
		// A plain action button (settings/remove) carries no data-hint-id → no hint.
		const action = document.createElement("button");
		document.body.appendChild(action);
		renderOverlay();
		const labels = screen.getAllByTestId("hint-label");
		expect(labels).toHaveLength(2);
	});

	it("targets the innermost element when a hint id is nested", () => {
		// A wrapper element around the clickable root, both carrying data-hint-id;
		// only the inner one owns the real click handler.
		const outer = makeCard("t1", 0);
		const inner = makeCard("t1", 0, outer);
		const outerClick = vi.fn();
		const innerClick = vi.fn();
		outer.addEventListener("click", outerClick);
		inner.addEventListener("click", innerClick);
		renderOverlay();

		// Only one label for the single (de-duped) task.
		expect(screen.getAllByTestId("hint-label")).toHaveLength(1);
		press("f");
		press("a"); // "fa" → t1
		expect(innerClick).toHaveBeenCalledTimes(1);
		// The wrapper still receives the bubbled click, but the inner handler is
		// what fired first — that's the one carrying navigation.
		expect(innerClick).toHaveBeenCalledTimes(1);
	});
});
