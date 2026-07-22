import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
	STREAMER_MODE_CHANGED_EVENT,
	STREAMER_MODE_STORAGE_KEY,
	initStreamerMode,
	isStreamerModeOn,
	setStreamerMode,
	toggleStreamerMode,
	useStreamerMode,
	Private,
} from "../streamer-mode";

beforeEach(() => {
	localStorage.clear();
	delete document.documentElement.dataset.streamer;
});

describe("streamer mode state", () => {
	it("is off by default", () => {
		expect(isStreamerModeOn()).toBe(false);
	});

	it("setStreamerMode(true) persists, sets the html attribute, and fires the change event", () => {
		const listener = vi.fn();
		window.addEventListener(STREAMER_MODE_CHANGED_EVENT, listener);
		setStreamerMode(true);
		window.removeEventListener(STREAMER_MODE_CHANGED_EVENT, listener);

		expect(isStreamerModeOn()).toBe(true);
		expect(localStorage.getItem(STREAMER_MODE_STORAGE_KEY)).toBe("on");
		expect(document.documentElement.dataset.streamer).toBe("on");
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("setStreamerMode(false) clears the html attribute", () => {
		setStreamerMode(true);
		setStreamerMode(false);
		expect(isStreamerModeOn()).toBe(false);
		expect(document.documentElement.dataset.streamer).toBeUndefined();
	});

	it("toggleStreamerMode flips the state and returns the new value", () => {
		expect(toggleStreamerMode()).toBe(true);
		expect(isStreamerModeOn()).toBe(true);
		expect(toggleStreamerMode()).toBe(false);
		expect(isStreamerModeOn()).toBe(false);
	});

	it("initStreamerMode applies the persisted state to <html>", () => {
		localStorage.setItem(STREAMER_MODE_STORAGE_KEY, "on");
		initStreamerMode();
		expect(document.documentElement.dataset.streamer).toBe("on");
	});

	it("initStreamerMode leaves <html> clean when persisted off", () => {
		localStorage.setItem(STREAMER_MODE_STORAGE_KEY, "off");
		initStreamerMode();
		expect(document.documentElement.dataset.streamer).toBeUndefined();
	});
});

describe("?streamer= URL parameter (agent QA entry point)", () => {
	function withSearch(search: string, fn: () => void) {
		window.history.replaceState(null, "", search || window.location.pathname);
		try {
			fn();
		} finally {
			window.history.replaceState(null, "", window.location.pathname);
		}
	}

	it("?streamer=on forces the mode on and persists it", () => {
		withSearch("?token=abc&streamer=on", () => {
			initStreamerMode();
			expect(document.documentElement.dataset.streamer).toBe("on");
			expect(localStorage.getItem(STREAMER_MODE_STORAGE_KEY)).toBe("on");
		});
	});

	it("?streamer=1 is accepted as on", () => {
		withSearch("?streamer=1", () => {
			initStreamerMode();
			expect(document.documentElement.dataset.streamer).toBe("on");
		});
	});

	it("?streamer=off overrides a persisted on", () => {
		localStorage.setItem(STREAMER_MODE_STORAGE_KEY, "on");
		withSearch("?streamer=off", () => {
			initStreamerMode();
			expect(document.documentElement.dataset.streamer).toBeUndefined();
			expect(localStorage.getItem(STREAMER_MODE_STORAGE_KEY)).toBe("off");
		});
	});

	it("an unrelated or garbage value falls back to the persisted state", () => {
		localStorage.setItem(STREAMER_MODE_STORAGE_KEY, "on");
		withSearch("?streamer=banana", () => {
			initStreamerMode();
			expect(document.documentElement.dataset.streamer).toBe("on");
		});
	});
});

describe("useStreamerMode", () => {
	function Probe() {
		const on = useStreamerMode();
		return <span data-testid="probe">{on ? "on" : "off"}</span>;
	}

	it("tracks toggles fired from anywhere", () => {
		render(<Probe />);
		expect(screen.getByTestId("probe").textContent).toBe("off");
		act(() => setStreamerMode(true));
		expect(screen.getByTestId("probe").textContent).toBe("on");
		act(() => setStreamerMode(false));
		expect(screen.getByTestId("probe").textContent).toBe("off");
	});
});

describe("Private", () => {
	it("wraps children in the streamer-private class", () => {
		render(<Private>secret@example.com</Private>);
		const el = screen.getByText("secret@example.com");
		expect(el.className).toBe("streamer-private");
	});

	it("merges an extra className", () => {
		render(<Private className="truncate">x</Private>);
		expect(screen.getByText("x").className).toBe("streamer-private truncate");
	});
});
