import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMenuAction } from "../menuRouter";
import type { AppState } from "../state";

// Own file because the whole `../rpc` module is mocked.
const { runDevServer, stopDevServer } = vi.hoisted(() => ({
	runDevServer: vi.fn(() => Promise.resolve({})),
	stopDevServer: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../rpc", () => ({ api: { request: { runDevServer, stopDevServer } } }));

const ctx = {
	state: { route: { screen: "task", projectId: "p1", taskId: "t1" } } as unknown as AppState,
	dispatch: vi.fn(),
	setLocale: vi.fn(),
	t: ((key: string) => key) as never,
};

beforeEach(() => vi.clearAllMocks());

describe("handleMenuAction — dev server menu items are user actions", () => {
	it("start asks for focus on the new pane", async () => {
		await handleMenuAction("project-dev-server-start", ctx);
		expect(runDevServer).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", focus: true });
	});

	it("restart asks for focus on the new pane", async () => {
		await handleMenuAction("project-dev-server-restart", ctx);
		expect(stopDevServer).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1" });
		expect(runDevServer).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", focus: true });
	});
});
