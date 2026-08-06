import { describe, expect, it, vi } from "vitest";
import { handleMenuAction } from "../menuRouter";
import type { AppState } from "../state";

// Own file because the whole `../rpc` module is mocked: the other menuRouter
// tests run against the real Electrobun proxy.
const { debugEmitTaskSound } = vi.hoisted(() => ({
	debugEmitTaskSound: vi.fn(() => Promise.resolve({ pushed: true })),
}));

vi.mock("../rpc", () => ({
	api: { request: { debugEmitTaskSound } },
}));

const ctx = {
	state: { route: { screen: "dashboard" } } as unknown as AppState,
	dispatch: vi.fn(),
	setLocale: vi.fn(),
	t: ((key: string) => key) as never,
};

describe("handleMenuAction — backend task-sound probe", () => {
	it("asks bun for a real taskSound push", async () => {
		await handleMenuAction("debug-push-sound-completed", ctx);
		expect(debugEmitTaskSound).toHaveBeenCalledWith({ status: "completed" });
	});
});
