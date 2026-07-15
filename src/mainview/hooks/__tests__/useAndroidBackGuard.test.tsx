import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useAndroidBackGuard } from "../useAndroidBackGuard";
import { registerBackLayer, __resetBackLayersForTests, BACK_SENTINEL_STATE } from "../../back-navigation";
import { ToastHost, toast } from "../../toast";

function Harness({
	routeBack,
	showExitToast,
	enabled = true,
}: {
	routeBack: () => boolean;
	showExitToast: () => void;
	enabled?: boolean;
}) {
	useAndroidBackGuard({ enabled, routeBack, showExitToast });
	return null;
}

/** Simulate the browser popping our sentinel entry (hardware Back press). */
function pressBack() {
	act(() => {
		window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
	});
}

beforeEach(() => {
	__resetBackLayersForTests();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useAndroidBackGuard", () => {
	it("arms the history sentinel on mount", () => {
		const pushState = vi.spyOn(window.history, "pushState");
		render(<Harness routeBack={() => false} showExitToast={() => {}} />);
		expect(pushState).toHaveBeenCalledWith(BACK_SENTINEL_STATE, "");
	});

	it("does nothing when disabled (desktop / Electrobun)", () => {
		const pushState = vi.spyOn(window.history, "pushState");
		const routeBack = vi.fn(() => true);
		render(<Harness enabled={false} routeBack={routeBack} showExitToast={() => {}} />);
		expect(pushState).not.toHaveBeenCalled();
		pressBack();
		expect(routeBack).not.toHaveBeenCalled();
	});

	it("closes the topmost open layer before touching route navigation", () => {
		const routeBack = vi.fn(() => true);
		const layerClose = vi.fn();
		render(<Harness routeBack={routeBack} showExitToast={() => {}} />);
		const unregister = registerBackLayer(layerClose);

		pressBack();
		expect(layerClose).toHaveBeenCalledOnce();
		expect(routeBack).not.toHaveBeenCalled();
		unregister();
	});

	it("navigates the in-app route history back when no layer is open", () => {
		const routeBack = vi.fn(() => true);
		const showExitToast = vi.fn();
		render(<Harness routeBack={routeBack} showExitToast={showExitToast} />);

		pressBack();
		expect(routeBack).toHaveBeenCalledOnce();
		expect(showExitToast).not.toHaveBeenCalled();
	});

	it("at the root: shows the exit toast, leaves the sentinel down, re-arms after the window", () => {
		const showExitToast = vi.fn();
		render(<Harness routeBack={() => false} showExitToast={showExitToast} />);
		const pushState = vi.spyOn(window.history, "pushState");
		pushState.mockClear();

		pressBack();
		expect(showExitToast).toHaveBeenCalledOnce();
		// Sentinel intentionally NOT restored yet — a second Back within the
		// window must perform the real browser navigation.
		expect(pushState).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(2_000);
		});
		expect(pushState).toHaveBeenCalledWith(BACK_SENTINEL_STATE, "");
	});

	it("ignores a forward navigation INTO the sentinel entry", () => {
		const routeBack = vi.fn(() => true);
		render(<Harness routeBack={routeBack} showExitToast={() => {}} />);

		act(() => {
			window.dispatchEvent(new PopStateEvent("popstate", { state: { dev3BackSentinel: true } }));
		});
		expect(routeBack).not.toHaveBeenCalled();
	});

	it("renders the double-back exit toast through the toast host", async () => {
		render(
			<>
				<ToastHost />
				<Harness
					routeBack={() => false}
					showExitToast={() => toast.info("Press Back again to exit", { durationMs: 2_500 })}
				/>
			</>,
		);

		pressBack();
		expect(screen.getByText("Press Back again to exit")).toBeInTheDocument();
	});
});
