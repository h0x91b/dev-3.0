import { render, screen, act } from "@testing-library/react";
import TaskCardRail, { shortenForRail, splitGraphemes } from "../TaskCardRail";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../../shared/types";

const project: Project = {
	id: "p1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

/** Drives the rail's own ResizeObserver, which happy-dom does not provide. */
function installResizeObserver(): { fire: () => void } {
	const callbacks: Array<() => void> = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(cb: () => void) {
				callbacks.push(cb);
			}
			observe() {}
			disconnect() {}
		},
	);
	return { fire: () => callbacks.forEach((cb) => cb()) };
}

function railHeight(px: number) {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => ({ height: px, width: 20, top: 0, left: 0, right: 20, bottom: px, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
	);
}

function renderRail({ autoLabel = true, customColumn = null }: { autoLabel?: boolean; customColumn?: { name: string; color: string } | null } = {}) {
	render(
		<I18nProvider>
			<TaskCardRail
				status="in-progress"
				project={project}
				customColumn={customColumn}
				color="#afbaff"
				canComplete={false}
				completing={false}
				onOpenMenu={vi.fn()}
				onComplete={vi.fn()}
				menuTriggerRef={{ current: null }}
				autoLabel={autoLabel}
			/>
		</I18nProvider>,
	);
}

function label(): HTMLElement | null {
	return screen.queryByTestId("task-card-rail-word");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("TaskCardRail autoLabel", () => {
	it("drops the upright word again when the row shrinks back", () => {
		const observer = installResizeObserver();
		railHeight(273); // a sidebar row carrying an overview
		renderRail();
		expect(label()).not.toBeNull();

		// The overview goes away with the task losing focus: the row is short again,
		// so the word must go with it instead of holding the height it needs.
		railHeight(88);
		act(() => observer.fire());
		expect(label()).toBeNull();
	});

	it("keeps the word out of flow so it never props up the height that measures it", () => {
		const observer = installResizeObserver();
		railHeight(273);
		renderRail();
		observer.fire();

		expect(label()!.className).toContain("absolute");
	});

	it("hides the word on a short row from the first paint", () => {
		installResizeObserver();
		railHeight(88);
		renderRail();

		expect(label()).toBeNull();
	});
});

// Issue #2040: WebKitGTK steps `text-orientation: upright` glyphs by their horizontal
// advance, so the word is stacked one grapheme per line instead of written vertically.
describe("TaskCardRail stacked word", () => {
	function cells(): string[] {
		return Array.from(label()!.children, (cell) => cell.textContent ?? "");
	}

	it("stacks one cell per letter without vertical writing mode", () => {
		renderRail({ autoLabel: false });

		expect(cells()).toEqual(["W", "O", "R", "K", "I", "N", "G"]);
		const rail = screen.getByTestId("task-card-rail");
		expect(rail.querySelector("[class*=writing-mode]")).toBeNull();
		expect(rail.querySelector("[class*=text-orientation]")).toBeNull();
	});

	it("keeps the space of a multi-word custom column as its own cell", () => {
		renderRail({ autoLabel: false, customColumn: { name: "On hold", color: "#14b8a6" } });

		expect(cells()).toEqual(["O", "N", "\u00a0", "H", "O", "L", "D"]);
	});

	it("keeps a combining accent on its letter instead of a cell of its own", () => {
		renderRail({ autoLabel: false, customColumn: { name: "e\u0301clair", color: "#ef4444" } });

		expect(cells()).toHaveLength(6);
		expect(cells()[0]).toBe("E\u0301");
	});

	it("leaves screen readers one readable label, not the stacked letters", () => {
		renderRail({ autoLabel: false });

		expect(label()).toHaveAttribute("aria-hidden", "true");
		expect(screen.getByRole("button", { name: /^Agent is Working — / })).toBeInTheDocument();
	});
});

describe("splitGraphemes / shortenForRail", () => {
	it("treats a ZWJ emoji sequence as one character", () => {
		expect(splitGraphemes("👩🏽‍💻ok")).toEqual(["👩🏽‍💻", "o", "k"]);
	});

	it("counts and cuts custom column names by grapheme, never mid-character", () => {
		expect(shortenForRail("e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301")).toBe("E\u0301E\u0301E\u0301E\u0301E\u0301E\u0301E\u0301E\u0301");
		expect(shortenForRail("👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻👩🏽‍💻", 3)).toBe("👩🏽‍💻👩🏽‍💻👩🏽‍💻");
		expect(shortenForRail("On hold")).toBe("ON HOLD");
	});
});
