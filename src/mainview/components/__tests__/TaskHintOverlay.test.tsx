import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n";
import TaskHintOverlay from "../TaskHintOverlay";

// Deterministic hints so we can drive multi-character typing without needing
// 27+ cards on screen. The real generator is covered by hintLabels.test.ts.
vi.mock("../../utils/hintLabels", () => ({
	DEFAULT_HINT_CHARS: "asdfghjklqwertyuiopzxcvbnm",
	generateHintStrings: (count: number) => ["fa", "fs", "fd"].slice(0, count),
}));

function makeCard(id: string, top: number, parent: HTMLElement = document.body): HTMLElement {
	const el = document.createElement("div");
	el.setAttribute("data-task-id", id);
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
			<TaskHintOverlay onExit={onExit} />
		</I18nProvider>,
	);
	return { onExit };
}

function press(key: string) {
	fireEvent.keyDown(document.body, { key });
}

describe("TaskHintOverlay", () => {
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
		const labels = screen.getAllByTestId("task-hint-label");
		expect(labels).toHaveLength(3);
		expect(labels.map((l) => l.getAttribute("data-hint")).sort()).toEqual(["fa", "fd", "fs"]);
	});

	it("exits immediately and renders nothing when there are no cards", () => {
		const { onExit } = renderOverlay();
		expect(onExit).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("task-hint-overlay")).toBeNull();
	});

	it("filters to matching hints as the user types a shared prefix", () => {
		makeCard("t1", 0);
		makeCard("t2", 60);
		makeCard("t3", 120);
		renderOverlay();
		press("f"); // prefix of all three
		expect(screen.getByTestId("task-hint-overlay").getAttribute("data-hint-typed")).toBe("f");
		expect(screen.getAllByTestId("task-hint-label")).toHaveLength(3);
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
		expect(screen.getByTestId("task-hint-overlay").getAttribute("data-hint-typed")).toBe("f");
		fireEvent.keyDown(document.body, { key: "Backspace" });
		expect(screen.getByTestId("task-hint-overlay").getAttribute("data-hint-typed")).toBe("");
		expect(screen.getAllByTestId("task-hint-label")).toHaveLength(3);
	});

	it("ignores keys that match no hint", () => {
		makeCard("t1", 0);
		makeCard("t2", 60);
		renderOverlay();
		press("z"); // valid hint char, but no hint starts with it
		expect(screen.getByTestId("task-hint-overlay").getAttribute("data-hint-typed")).toBe("");
		expect(screen.getAllByTestId("task-hint-label")).toHaveLength(2);
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

	it("targets the innermost element when a task id is nested", () => {
		// Mirrors the board: a wrapper <div data-task-id> around the card root,
		// which also has data-task-id and owns the real click handler.
		const outer = makeCard("t1", 0);
		const inner = makeCard("t1", 0, outer);
		const outerClick = vi.fn();
		const innerClick = vi.fn();
		outer.addEventListener("click", outerClick);
		inner.addEventListener("click", innerClick);
		renderOverlay();

		// Only one label for the single (de-duped) task.
		expect(screen.getAllByTestId("task-hint-label")).toHaveLength(1);
		press("f");
		press("a"); // "fa" → t1
		expect(innerClick).toHaveBeenCalledTimes(1);
		// The wrapper still receives the bubbled click, but the inner handler is
		// what fired first — that's the one carrying navigation.
		expect(innerClick).toHaveBeenCalledTimes(1);
	});
});
