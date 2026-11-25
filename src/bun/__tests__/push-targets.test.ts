/**
 * `pushEverywhere` is the only push the desktop entry is allowed to use, because
 * it is the only one that reaches both audiences: the Electrobun windows and any
 * browser attached over the remote-access server. Reaching one and not the other
 * is exactly the bug this module exists to close — a remote client kept rendering
 * a terminal the app already knew was dead.
 *
 * The companion guard, `push-targets-wiring.test.ts`, asserts that every call
 * site in `src/bun/index.ts` actually goes through here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastToAllWindows = vi.fn();
const sendToFocusedWindow = vi.fn();
const pushToBrowserClients = vi.fn();

vi.mock("../window-manager", () => ({ broadcastToAllWindows, sendToFocusedWindow }));
vi.mock("../remote-access-server", () => ({ pushToBrowserClients }));

const { pushEverywhere } = await import("../push-targets");

describe("pushEverywhere", () => {
	beforeEach(() => {
		broadcastToAllWindows.mockClear();
		sendToFocusedWindow.mockClear();
		pushToBrowserClients.mockClear();
	});

	it("delivers an event to desktop windows AND remote browsers, once each, payload untouched", () => {
		const payload = { taskId: "task-1", ports: [3000, 5173] };
		pushEverywhere("ptyDied", payload);

		expect(broadcastToAllWindows).toHaveBeenCalledWith("ptyDied", payload);
		expect(pushToBrowserClients).toHaveBeenCalledWith("ptyDied", payload);
		expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
		expect(pushToBrowserClients).toHaveBeenCalledTimes(1);
		// Same object, not a copy: the renderer contract is the payload as built.
		expect(broadcastToAllWindows.mock.calls[0][1]).toBe(payload);
		expect(pushToBrowserClients.mock.calls[0][1]).toBe(payload);
	});

	// A sound is not state: every window renders its own state, but they all share
	// one pair of speakers, so a broadcast chime plays once per open window.
	// Remote-only setups exist: a phone on the LAN with no desktop window in view
	// is the whole point of the push, so browsers keep the full fan-out.
	it("sends a completion chime to the focused window only, but still to every remote browser", () => {
		const payload = { status: "completed", taskId: "task-3" };
		pushEverywhere("taskSound", payload);

		expect(sendToFocusedWindow).toHaveBeenCalledWith("taskSound", payload);
		expect(broadcastToAllWindows).not.toHaveBeenCalled();
		expect(pushToBrowserClients).toHaveBeenCalledWith("taskSound", payload);
	});
});
