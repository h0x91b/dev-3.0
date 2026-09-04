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
const pushToBrowserClients = vi.fn();

vi.mock("../window-manager", () => ({ broadcastToAllWindows }));
vi.mock("../remote-access-server", () => ({ pushToBrowserClients }));

const { pushEverywhere } = await import("../push-targets");

describe("pushEverywhere", () => {
	beforeEach(() => {
		broadcastToAllWindows.mockClear();
		pushToBrowserClients.mockClear();
	});

	it("delivers a terminal death to desktop windows AND remote browsers", () => {
		pushEverywhere("ptyDied", { taskId: "task-1" });

		expect(broadcastToAllWindows).toHaveBeenCalledWith("ptyDied", { taskId: "task-1" });
		expect(pushToBrowserClients).toHaveBeenCalledWith("ptyDied", { taskId: "task-1" });
	});

	it("passes name and payload through untouched, whatever the event", () => {
		const payload = { taskId: "task-2", ports: [3000, 5173] };
		pushEverywhere("portsUpdated", payload);

		expect(broadcastToAllWindows).toHaveBeenCalledWith("portsUpdated", payload);
		expect(pushToBrowserClients).toHaveBeenCalledWith("portsUpdated", payload);
		// Same object, not a copy: the renderer contract is the payload as built.
		expect(broadcastToAllWindows.mock.calls[0][1]).toBe(payload);
		expect(pushToBrowserClients.mock.calls[0][1]).toBe(payload);
	});

	it("pushes exactly once per target per call", () => {
		pushEverywhere("projectPtyDied", { projectId: "p1" });

		expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
		expect(pushToBrowserClients).toHaveBeenCalledTimes(1);
	});
});
