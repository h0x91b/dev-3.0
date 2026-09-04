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

vi.mock("../git", () => ({
	taskDir: (_project: unknown, task: { id: string }) => `/tmp/wt/${task.id.slice(0, 8)}`,
}));

import { wrapAgentMessage } from "../../shared/agent-message-envelope";
import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES } from "../../shared/types";
import { buildHandoffMessage, deliverLaunchHandoff, HANDOFF_SUBJECT } from "../agent-launch-handoff";

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

// The instruction the coordinator used to type by hand after every launch. If it
// falls out of the default note, every launcher silently goes back to doing that.
describe("buildHandoffMessage", () => {
	it("names the reports dir and asks for the path back, with no launcher note at all", () => {
		const body = buildHandoffMessage("/tmp/wt/child-12/reports");
		expect(body).toContain("/tmp/wt/child-12/reports/");
		expect(body).toMatch(/as a FILE/);
		expect(body).toMatch(/absolute path/);
		expect(body).toMatch(/description is the brief/);
	});

	it("appends the launcher's standing text under the default, never instead of it", () => {
		const body = buildHandoffMessage("/tmp/wt/child-12/reports", "  Protocol: read orders/PROTOCOL.md  ");
		expect(body).toContain("absolute path");
		expect(body).toContain("Standing instructions from your launcher:\nProtocol: read orders/PROTOCOL.md");
		expect(body.indexOf("absolute path")).toBeLessThan(body.indexOf("Standing instructions"));
	});

	it("ignores a blank launcher note", () => {
		expect(buildHandoffMessage("/r", "   \n ")).toBe(buildHandoffMessage("/r"));
	});

	// The default note must fit ONE pty read, envelope included. Over the threshold
	// it spills to a file, and the first thing a booting agent would hear is a
	// pointer to its own handoff — the very indirection this note exists to explain.
	it("fits one pty read with a long path and a long sender title", () => {
		const reportsDir = `/Users/someone/.dev3.0/worktrees/${"Users-someone-Desktop-src-shared-dev-3.0"}/2d6381a0/reports`;
		const wrapped = wrapAgentMessage(
			buildHandoffMessage(reportsDir),
			{ taskId: "47205843-3a29-4693-97af-3ce852b5f898", seq: 1141, seqShared: false, title: "Coordinator — orchestrating the dev-3.0 board and its children", projectId: "p1" },
			"p1",
			HANDOFF_SUBJECT,
		);
		expect(Buffer.byteLength(wrapped)).toBeLessThanOrEqual(AGENT_MESSAGE_SPILL_THRESHOLD_BYTES);
	});
});

describe("deliverLaunchHandoff", () => {
	it("delivers the note once the child's agent pane is up", async () => {
		getTask.mockResolvedValue(liveTask());
		await expect(deliverLaunchHandoff({ projectId: "p1", childTaskId: "child-1234", source })).resolves.toBe(true);
		expect(sendMessageImmediately).toHaveBeenCalledWith(
			expect.objectContaining({ id: "child-1234" }),
			buildHandoffMessage("/tmp/wt/child-12/reports"),
			null,
			source,
			{ hold: false, subject: HANDOFF_SUBJECT },
		);
	});

	it("carries the launcher's handoff note into the delivered body", async () => {
		getTask.mockResolvedValue(liveTask());
		await deliverLaunchHandoff({ projectId: "p1", childTaskId: "child-1234", source, launcherNote: "Report to Seq 1141 only." });
		expect(sendMessageImmediately.mock.calls[0]?.[1]).toContain("Report to Seq 1141 only.");
	});

	// A held handoff would leave a freshly booted agent idle for the whole quiet
	// window while its launcher waits for a reply that cannot come.
	it("never holds the note — the child hears it at once", async () => {
		getTask.mockResolvedValue(liveTask());
		await deliverLaunchHandoff({ projectId: "p1", childTaskId: "child-1234", source });
		expect(sendMessageImmediately.mock.calls[0]?.[4]).toMatchObject({ hold: false });
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
