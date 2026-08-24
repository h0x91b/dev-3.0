import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const getProject = vi.fn();
const getTask = vi.fn();
vi.mock("../data", () => ({
	getProject: (...args: unknown[]) => getProject(...args),
	getTask: (...args: unknown[]) => getTask(...args),
}));

const sendMessageImmediately = vi.fn();
vi.mock("../scheduled-message-scheduler", () => ({
	sendMessageImmediately: (...args: unknown[]) => sendMessageImmediately(...args),
}));

const pushCliToast = vi.fn();
vi.mock("../rpc-handlers", () => ({
	pushCliToast: (...args: unknown[]) => pushCliToast(...args),
}));

import { deliverLaunchHandoff, HANDOFF_MESSAGE } from "../agent-launch-handoff";

const project = { id: "p1", path: "/tmp/proj" };
const source = { taskId: "parent", seq: 7, title: "Parent" };

function liveTask(overrides: Record<string, unknown> = {}) {
	return {
		id: "child-1234",
		status: "in-progress",
		preparing: false,
		sessionState: { panes: [{ paneId: "%1" }] },
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getProject.mockResolvedValue(project);
	sendMessageImmediately.mockResolvedValue({ status: "delivered", spilledPath: null });
});

describe("deliverLaunchHandoff", () => {
	it("delivers the note once the child's agent pane is up", async () => {
		getTask.mockResolvedValue(liveTask());
		await expect(deliverLaunchHandoff({ projectId: "p1", childTaskId: "child-1234", source })).resolves.toBe(true);
		expect(sendMessageImmediately).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1234" }), HANDOFF_MESSAGE, null, source, { hold: false });
	});

	// A held handoff would leave a freshly booted agent idle for the whole quiet
	// window while its launcher waits for a reply that cannot come.
	it("never holds the note — the child hears it at once", async () => {
		getTask.mockResolvedValue(liveTask());
		await deliverLaunchHandoff({ projectId: "p1", childTaskId: "child-1234", source });
		expect(sendMessageImmediately.mock.calls[0]?.[4]).toEqual({ hold: false });
	});

	it("gives up without sending when the child is already terminal", async () => {
		getTask.mockResolvedValue(liveTask({ status: "cancelled" }));
		await expect(deliverLaunchHandoff({ projectId: "p1", childTaskId: "child-1234", source })).resolves.toBe(false);
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});

	it("waits for the pane and toasts when it never comes up", async () => {
		getTask.mockResolvedValue(liveTask({ preparing: true }));
		let clock = 0;
		const result = await deliverLaunchHandoff({
			projectId: "p1",
			childTaskId: "child-1234",
			source,
			sleep: async () => { clock += 1_000; },
			now: () => clock,
		});
		expect(result).toBe(false);
		expect(sendMessageImmediately).not.toHaveBeenCalled();
		expect(pushCliToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
	});
});
