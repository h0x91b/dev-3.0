import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useContainerWidth } from "../useContainerWidth";

type Cb = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;

/** Stub ResizeObserver (happy-dom has none) that reports `width` on observe. */
function stubResizeObserver(width: number, onDisconnect?: () => void) {
	class StubResizeObserver {
		constructor(private cb: Cb) {}
		observe(el: Element) {
			this.cb(
				[{ target: el, contentRect: { width } } as unknown as ResizeObserverEntry],
				this as unknown as ResizeObserver,
			);
		}
		unobserve() {}
		disconnect() {
			onDisconnect?.();
		}
	}
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
}

function renderWithElement() {
	return renderHook(() => {
		const ref = useRef<HTMLDivElement | null>(null);
		if (!ref.current) ref.current = document.createElement("div");
		return useContainerWidth(ref);
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("useContainerWidth", () => {
	it("reports the observed width", () => {
		stubResizeObserver(742);
		const { result } = renderWithElement();
		expect(result.current).toBe(742);
	});

	it("returns 0 when ResizeObserver is unavailable", () => {
		vi.stubGlobal("ResizeObserver", undefined);
		const { result } = renderWithElement();
		expect(result.current).toBe(0);
	});

	it("disconnects the observer on unmount", () => {
		const onDisconnect = vi.fn();
		stubResizeObserver(500, onDisconnect);
		const { unmount } = renderWithElement();
		unmount();
		expect(onDisconnect).toHaveBeenCalledTimes(1);
	});
});
