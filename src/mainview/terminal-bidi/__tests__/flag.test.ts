import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getTerminalBidiEnabled,
	resetTerminalBidiForTests,
	syncTerminalBidiFromGlobalSettings,
	TERMINAL_BIDI_CHANGED_EVENT,
} from "../flag";

afterEach(() => {
	resetTerminalBidiForTests();
});

function listen() {
	const handler = vi.fn();
	window.addEventListener(TERMINAL_BIDI_CHANGED_EVENT, handler);
	return {
		handler,
		stop: () => window.removeEventListener(TERMINAL_BIDI_CHANGED_EVENT, handler),
	};
}

describe("terminal bidi flag", () => {
	it("is off until settings say otherwise", () => {
		expect(getTerminalBidiEnabled()).toBe(false);
		syncTerminalBidiFromGlobalSettings({});
		expect(getTerminalBidiEnabled()).toBe(false);
	});

	it("treats anything but an explicit true as off", () => {
		syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: undefined });
		expect(getTerminalBidiEnabled()).toBe(false);
	});

	it("announces a change so open panes can apply it live", () => {
		const { handler, stop } = listen();

		syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: true });
		expect(getTerminalBidiEnabled()).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
		expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(true);

		syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: false });
		expect(getTerminalBidiEnabled()).toBe(false);
		expect((handler.mock.calls[1][0] as CustomEvent).detail).toBe(false);

		stop();
	});

	it("stays quiet when the value did not change", () => {
		syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: true });
		const { handler, stop } = listen();

		// Every settings push re-runs this; only real changes may repaint panes.
		syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: true });
		syncTerminalBidiFromGlobalSettings({ experimentalTerminalBidi: true });
		expect(handler).not.toHaveBeenCalled();

		stop();
	});
});
