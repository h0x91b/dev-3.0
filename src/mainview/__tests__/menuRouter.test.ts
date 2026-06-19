import { describe, expect, it, vi } from "vitest";
import { handleMenuAction } from "../menuRouter";
import type { AppState } from "../state";

// These palette actions only dispatch a window CustomEvent (App.tsx opens the
// palette) — they never touch state, dispatch, or locale, so a bare ctx is fine.
const ctx = {
	state: { route: { screen: "dashboard" } } as unknown as AppState,
	dispatch: vi.fn(),
	setLocale: vi.fn(),
};

describe("handleMenuAction — palette openers", () => {
	it("dispatches menu:open-project-switch for open-project-switch", async () => {
		const listener = vi.fn();
		window.addEventListener("menu:open-project-switch", listener);
		await handleMenuAction("open-project-switch", ctx);
		window.removeEventListener("menu:open-project-switch", listener);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("dispatches menu:open-command-palette for open-command-palette", async () => {
		const listener = vi.fn();
		window.addEventListener("menu:open-command-palette", listener);
		await handleMenuAction("open-command-palette", ctx);
		window.removeEventListener("menu:open-command-palette", listener);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
