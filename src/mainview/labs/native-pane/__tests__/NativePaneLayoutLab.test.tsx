import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import NativePaneLayoutLab from "../NativePaneLayoutLab";
import { FakeTerminalRegistry } from "../fake-terminal";

class ResizeObserverStub {
	observe(): void {}
	disconnect(): void {}
}

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;
const originalResizeObserver = globalThis.ResizeObserver;

function mockViewport(width: number): void {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn((query: string) => {
			const max = /max-width:\s*(\d+)px/.exec(query);
			return {
				matches: max ? width <= Number(max[1]) : false,
				media: query,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			};
		}),
	});
	Object.defineProperty(globalThis, "ResizeObserver", {
		configurable: true,
		value: ResizeObserverStub,
	});
}

function renderLab(width = 1200): { registry: FakeTerminalRegistry; unmount: () => void } {
	mockViewport(width);
	const registry = new FakeTerminalRegistry({ outputIntervalMs: 60_000 });
	const result = render(
		<I18nProvider>
			<NativePaneLayoutLab navigate={vi.fn()} registry={registry} />
		</I18nProvider>,
	);
	return { registry, unmount: result.unmount };
}

afterEach(() => {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
	Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
});

describe("NativePaneLayoutLab", () => {
	it("renders 1, 2, and 6 independent fake terminal streams with stable remount identity", async () => {
		const user = userEvent.setup();
		const { registry, unmount } = renderLab();
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: "2 panes" }));
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(2);
		await user.click(screen.getByRole("button", { name: "6 panes" }));
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(6);
		expect(document.querySelector("main")).toHaveClass("flex");
		expect(document.querySelector('[data-split-id="split-1"]')).toHaveClass("h-full");

		const paneOne = screen.getByTestId("fake-pane-pane-1");
		const paneTwo = screen.getByTestId("fake-pane-pane-2");
		const streamId = paneOne.getAttribute("data-stream-id");
		await user.type(within(paneOne).getByRole("textbox", { name: "Input for pane-1" }), "alpha-only");
		await user.click(within(paneOne).getByRole("button", { name: "Send to pane-1" }));
		expect(paneOne).toHaveTextContent("alpha-only");
		expect(paneTwo).not.toHaveTextContent("alpha-only");

		await user.click(screen.getByRole("button", { name: "Remount terminal views" }));
		const remountedPaneOne = screen.getByTestId("fake-pane-pane-1");
		expect(remountedPaneOne).toHaveAttribute("data-stream-id", streamId);
		expect(remountedPaneOne).toHaveTextContent("alpha-only");

		unmount();
		expect(registry.diagnostics()).toMatchObject({
			activeSessions: 0,
			runningTimers: 0,
			outputSubscriptions: 0,
			inputSubscriptions: 0,
			resizeSubscriptions: 0,
		});
	});

	it("applies focus, split, ratio, zoom, close, and restore to the intended pane", async () => {
		const user = userEvent.setup();
		renderLab();
		await user.click(screen.getByRole("button", { name: "2 panes" }));
		await user.click(screen.getByTestId("fake-pane-pane-1"));
		expect(screen.getByTestId("fake-pane-pane-1")).toHaveAttribute("data-active", "true");

		await user.click(screen.getByRole("button", { name: "Focus right" }));
		expect(screen.getByTestId("fake-pane-pane-2")).toHaveAttribute("data-active", "true");
		await user.click(screen.getByRole("button", { name: "Save layout snapshot" }));
		await user.click(screen.getByRole("button", { name: "Split vertically" }));
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(3);
		expect(screen.getByTestId("fake-pane-pane-3")).toHaveAttribute("data-active", "true");

		const ratio = screen.getByRole("slider", { name: "Split ratio for pane-3" });
		fireEvent.change(ratio, { target: { value: "70" } });
		expect(ratio).toHaveValue("70");

		await user.click(screen.getByRole("button", { name: "Zoom active pane" }));
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(1);
		expect(screen.getByTestId("fake-pane-pane-3")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Unzoom pane" }));
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(3);

		await user.click(screen.getByRole("button", { name: "Close active pane" }));
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(2);
		await user.click(screen.getByRole("button", { name: "Restore layout snapshot" }));
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(2);
		expect(screen.getByTestId("fake-pane-pane-2")).toHaveAttribute("data-active", "true");
	});

	it("shows one active pane with visible button and keyboard paging on narrow screens", async () => {
		const user = userEvent.setup();
		renderLab(390);
		await user.click(screen.getByRole("button", { name: "6 panes" }));
		const lab = screen.getByTestId("native-pane-layout-lab");
		expect(lab).toHaveAttribute("data-layout-mode", "narrow");
		expect(screen.getAllByTestId(/^fake-pane-/)).toHaveLength(1);
		expect(screen.getByTestId("fake-pane-pane-1")).toHaveClass("w-full");
		expect(screen.getByText("Pane 1 of 6")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Next pane" }));
		expect(screen.getByTestId("fake-pane-pane-2")).toBeInTheDocument();
		expect(screen.getByText("Pane 2 of 6")).toBeInTheDocument();

		lab.focus();
		await user.keyboard("{ArrowRight}");
		expect(screen.getByTestId("fake-pane-pane-3")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Previous pane" }));
		expect(screen.getByTestId("fake-pane-pane-2")).toBeInTheDocument();
	});

	it("aborts stress work when the lab unmounts", async () => {
		vi.useFakeTimers();
		try {
			const { unmount } = renderLab();
			fireEvent.click(screen.getByRole("button", { name: "Run stress baseline" }));
			expect(vi.getTimerCount()).toBeGreaterThan(1);

			unmount();
			await Promise.resolve();
			await Promise.resolve();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});
