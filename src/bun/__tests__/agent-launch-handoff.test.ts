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
const pushCliAttention = vi.fn();
vi.mock("../rpc-handlers", () => ({
	pushCliToast: (...args: unknown[]) => pushCliToast(...args),
	pushCliAttention: (...args: unknown[]) => pushCliAttention(...args),
}));

vi.mock("../git", () => ({
	taskDir: (_project: unknown, task: { id: string }) => `/tmp/wt/${task.id.slice(0, 8)}`,
}));

import { wrapAgentMessage } from "../../shared/agent-message-envelope";
import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES } from "../../shared/types";
import { buildHandoffMessage, deliverLaunchHandoff, HANDOFF_SUBJECT } from "../agent-launch-handoff";
import { noteAgentExited, noteAgentLaunched, noteAgentSessionStarted, resetAgentSessionRecordsForTests } from "../agent-session-receipts";

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
	resetAgentSessionRecordsForTests();
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

// #2034: a Claude session this app launched is typed into only after it says it
// is past its startup dialogs — the trust prompt's default is "No, exit".
describe("deliverLaunchHandoff — a launched Claude session", () => {
	const SESSION = "11111111-2222-4333-8444-555555555555";
	const claudeTask = () => liveTask({ sessionState: { panes: [{ paneId: "%1", sessionId: SESSION, agentCmd: "claude" }] } });

	/** Runs the handoff on a fake clock; `onTick` may change the world between polls. */
	function runWithClock(onTick: (elapsedMs: number) => void = () => {}) {
		let clock = 0;
		return deliverLaunchHandoff({
			projectId: "p1",
			childTaskId: "child-1234",
			source,
			sleep: async (ms) => {
				clock += ms;
				onTick(clock);
			},
			now: () => clock,
		});
	}

	beforeEach(() => {
		getTask.mockResolvedValue(claudeTask());
		noteAgentLaunched("child-1234", SESSION);
	});

	it("types nothing while the session has not started — badges the card, then gives up with a toast", async () => {
		await expect(runWithClock()).resolves.toBe(false);

		expect(sendMessageImmediately).not.toHaveBeenCalled();
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
		expect(pushCliAttention.mock.calls[0]![0]).toMatchObject({ taskId: "child-1234", reason: expect.stringContaining("has not finished starting") });
		expect(pushCliToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
	});

	it("delivers once, into the pane the SessionStart receipt came from, after a human-length wait", async () => {
		const result = await runWithClock((elapsed) => {
			if (elapsed === 300_000) noteAgentSessionStarted("child-1234", SESSION, "%9");
		});

		expect(result).toBe(true);
		expect(sendMessageImmediately).toHaveBeenCalledTimes(1);
		expect(sendMessageImmediately.mock.calls[0]![2]).toEqual({ kind: "pane", paneId: "%9" });
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
	});

	it("does not open for a receipt from another session — a previous run or a second agent", async () => {
		noteAgentSessionStarted("child-1234", "some-other-session", "%1");
		noteAgentSessionStarted("other-task", SESSION, "%1");
		await expect(runWithClock()).resolves.toBe(false);
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});

	it("stops at once when the agent exits before its session started (trust declined)", async () => {
		const result = await runWithClock((elapsed) => {
			if (elapsed === 5_000) noteAgentExited("child-1234", SESSION, 1);
		});

		expect(result).toBe(false);
		expect(sendMessageImmediately).not.toHaveBeenCalled();
		expect(pushCliToast).toHaveBeenCalledTimes(1);
		expect(pushCliToast.mock.calls[0]![0].message).toMatch(/exited before/);
	});

	it("types nothing once the agent exited, even after its session had started", async () => {
		const result = await runWithClock((elapsed) => {
			if (elapsed === 3_000) {
				noteAgentSessionStarted("child-1234", SESSION, "%1");
				noteAgentExited("child-1234", SESSION, 0);
			}
		});
		expect(result).toBe(false);
		expect(sendMessageImmediately).not.toHaveBeenCalled();
	});

	it("abandons, with a toast, when the task is relaunched under a new session before the note lands", async () => {
		const result = await runWithClock((elapsed) => {
			if (elapsed === 10_000) {
				getTask.mockResolvedValue(liveTask({ sessionState: { panes: [{ paneId: "%2", sessionId: "relaunch", agentCmd: "claude" }] } }));
				noteAgentLaunched("child-1234", "relaunch");
				noteAgentSessionStarted("child-1234", "relaunch", "%2");
			}
		});
		expect(result).toBe(false);
		expect(sendMessageImmediately).not.toHaveBeenCalled();
		expect(pushCliToast.mock.calls[0]![0].message).toMatch(/restarted/);
	});

	it("gives a send that keeps failing after the receipt the ordinary budget, not the boot ceiling", async () => {
		noteAgentSessionStarted("child-1234", SESSION, "%1");
		sendMessageImmediately.mockRejectedValue(new Error("no live agent session"));
		let clock = 0;
		const result = await deliverLaunchHandoff({
			projectId: "p1", childTaskId: "child-1234", source,
			sleep: async (ms) => { clock += ms; },
			now: () => clock,
		});

		expect(result).toBe(false);
		expect(clock).toBeLessThanOrEqual(125_000);
	});

	it("keeps the pane-exists rule for a session nobody registered (other harnesses, older launches)", async () => {
		resetAgentSessionRecordsForTests();
		await expect(runWithClock()).resolves.toBe(true);
		expect(sendMessageImmediately.mock.calls[0]![2]).toBeNull();
	});
});
