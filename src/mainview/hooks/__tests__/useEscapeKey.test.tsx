import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEscapeKey } from "../useEscapeKey";

/** Dispatch a cancelable, bubbling Escape (or other key) from a node. */
function pressKey(key: string, from: EventTarget = window): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
	from.dispatchEvent(event);
	return event;
}

describe("useEscapeKey", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("invokes the callback on Escape", () => {
		const onEscape = vi.fn();
		renderHook(() => useEscapeKey(onEscape));
		pressKey("Escape");
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("calls preventDefault so Escape never reaches native fullscreen exit", () => {
		renderHook(() => useEscapeKey(() => {}));
		const event = pressKey("Escape");
		expect(event.defaultPrevented).toBe(true);
	});

	it("ignores keys other than Escape", () => {
		const onEscape = vi.fn();
		renderHook(() => useEscapeKey(onEscape));
		pressKey("Enter");
		pressKey("a");
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("does not register while disabled", () => {
		const onEscape = vi.fn();
		renderHook(() => useEscapeKey(onEscape, { enabled: false }));
		const event = pressKey("Escape");
		expect(onEscape).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("re-registers when enabled flips from false to true", () => {
		const onEscape = vi.fn();
		const { rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useEscapeKey(onEscape, { enabled }),
			{ initialProps: { enabled: false } },
		);
		pressKey("Escape");
		expect(onEscape).not.toHaveBeenCalled();

		rerender({ enabled: true });
		pressKey("Escape");
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("removes the listener on unmount", () => {
		const onEscape = vi.fn();
		const { unmount } = renderHook(() => useEscapeKey(onEscape));
		unmount();
		pressKey("Escape");
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("always calls the latest callback without a dependency array", () => {
		const first = vi.fn();
		const second = vi.fn();
		const { rerender } = renderHook(
			({ cb }: { cb: () => void }) => useEscapeKey(cb),
			{ initialProps: { cb: first } },
		);
		rerender({ cb: second });
		pressKey("Escape");
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("stops propagation so other window listeners do not also fire", () => {
		const onEscape = vi.fn();
		const other = vi.fn();
		// A bubble-phase window listener stands in for App's global back-nav handler.
		window.addEventListener("keydown", other);
		renderHook(() => useEscapeKey(onEscape));

		// Dispatch from a child node so the hook's capture listener fires first.
		const child = document.createElement("div");
		document.body.appendChild(child);
		pressKey("Escape", child);
		child.remove();

		window.removeEventListener("keydown", other);
		expect(onEscape).toHaveBeenCalledTimes(1);
		expect(other).not.toHaveBeenCalled();
	});
});
