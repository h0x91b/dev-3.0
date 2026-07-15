import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import MobilePortraitGate from "../MobilePortraitGate";
import { useMobile } from "../../hooks/useMobile";

vi.mock("../../hooks/useMobile", () => ({
	useMobile: vi.fn(),
}));

const mockedUseMobile = vi.mocked(useMobile);
const originalMatchMedia = window.matchMedia;
const originalOrientation = Object.getOwnPropertyDescriptor(window.screen, "orientation");

describe("MobilePortraitGate", () => {
	let landscape = false;
	let lock: ReturnType<typeof vi.fn>;
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const mediaQuery = {
		get matches() {
			return landscape;
		},
		media: "(orientation: landscape)",
		onchange: null,
		addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
			listeners.delete(listener);
		},
		addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
		removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
		dispatchEvent: vi.fn(),
	} as unknown as MediaQueryList;

	beforeEach(() => {
		landscape = false;
		listeners.clear();
		lock = vi.fn().mockResolvedValue(undefined);
		mockedUseMobile.mockReturnValue(true);
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: vi.fn(() => mediaQuery),
		});
		Object.defineProperty(window.screen, "orientation", {
			configurable: true,
			value: { lock },
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: originalMatchMedia,
		});
		if (originalOrientation) {
			Object.defineProperty(window.screen, "orientation", originalOrientation);
		} else {
			Object.defineProperty(window.screen, "orientation", {
				configurable: true,
				value: undefined,
			});
		}
	});

	function renderGate() {
		return render(
			<I18nProvider>
				<MobilePortraitGate>
					<div data-testid="app-content">App content</div>
				</MobilePortraitGate>
			</I18nProvider>,
		);
	}

	it("keeps the app available in portrait", () => {
		renderGate();

		expect(screen.queryByTestId("mobile-portrait-gate")).not.toBeInTheDocument();
		expect(screen.getByTestId("app-content")).toBeInTheDocument();
		expect(lock).toHaveBeenCalledWith("portrait");
	});

	it("blocks mobile content in landscape and asks for portrait", () => {
		landscape = true;
		renderGate();

		expect(screen.getByTestId("mobile-portrait-gate")).toHaveTextContent("Rotate to portrait");
		expect(screen.getByTestId("app-content").parentElement).toHaveAttribute("inert");
		expect(screen.getByTestId("app-content").parentElement).toHaveAttribute("aria-hidden", "true");
		expect(lock).toHaveBeenCalledWith("portrait");
	});

	it("removes the gate when the viewport returns to portrait", () => {
		landscape = true;
		renderGate();

		act(() => {
			landscape = false;
			for (const listener of listeners) listener({ matches: false } as MediaQueryListEvent);
		});

		expect(screen.queryByTestId("mobile-portrait-gate")).not.toBeInTheDocument();
		expect(screen.getByTestId("app-content").parentElement).not.toHaveAttribute("inert");
	});

	it("does not block a desktop browser window in landscape", () => {
		landscape = true;
		mockedUseMobile.mockReturnValue(false);
		renderGate();

		expect(screen.queryByTestId("mobile-portrait-gate")).not.toBeInTheDocument();
		expect(lock).not.toHaveBeenCalled();
	});

	it("keeps the fallback visible when the browser rejects the lock", async () => {
		landscape = true;
		lock.mockRejectedValueOnce(new Error("fullscreen required"));
		renderGate();

		await act(async () => {});

		expect(screen.getByTestId("mobile-portrait-gate")).toBeInTheDocument();
	});
});
