import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The BOUNDARY between two messages that share one turn, asserted on the text the pane
// actually receives — through `holdMessageForPane`, the path a real `dev3 message`
// takes, with only the pane seam mocked. Byte counts are deliberately not the subject:
// a welded burst has exactly the right number of bytes (issue #1608).
vi.mock("../pane-input", () => ({
	sendPaneInput: vi.fn(),
	deliverPaneInput: vi.fn(),
	newPaneInputDeliveryId: (prefix: string) => `${prefix}-1`,
	pinTaskPane: vi.fn(async () => ({
		ok: true,
		incarnation: { backend: "tmux", taskId: "task-1234", paneId: "%1", sessionName: "s", serverToken: "t" },
	})),
}));
vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	taskSessionName: (taskId: string) => `dev3-task-${taskId}`,
	PANE_ID_FORMAT: "pane-id",
	TMUX_AGENT_PANE_OPTION: "@dev3_agent_pane",
	TMUX_LAST_AGENT_PANE_OPTION: "@dev3_last_agent_pane",
	tmux: {
		listPanes: vi.fn(async () => [{ paneId: "%1" }]),
		activePaneId: vi.fn(async () => "%1"),
		setPaneOption: vi.fn(async () => undefined),
		showOption: vi.fn(async () => ""),
	},
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { deliverPaneInput, sendPaneInput } from "../pane-input";
import { holdMessageForPane } from "../agent-prompt";
import { resetAgentMessageHolds } from "../agent-message-hold";
import { wrapAgentMessage } from "../../shared/agent-message-envelope";
import type { Task } from "../../shared/types";

const PANE = "%1";
const task = { id: "task-1234", projectId: "p1", worktreePath: "/tmp/w" } as Task;

const envelope = (body: string, seq: number) =>
	wrapAgentMessage(body, { taskId: `t${seq}`, seq, title: `child ${seq}` }, "p1", `report ${seq}`);

/** Everything typed into the pane, in the order it was typed: held texts pin first, the rest do not. */
function typedText(): string {
	const calls = [
		...vi.mocked(deliverPaneInput).mock.calls.map((call, i) => ({ order: vi.mocked(deliverPaneInput).mock.invocationCallOrder[i]!, stages: call[1].stages })),
		...vi.mocked(sendPaneInput).mock.calls.map((call, i) => ({ order: vi.mocked(sendPaneInput).mock.invocationCallOrder[i]!, stages: call[2] })),
	].sort((a, b) => a.order - b.order);
	return calls.flatMap(({ stages }) => stages.flatMap((stage) => stage.steps.map((step) => ("text" in step ? step.text : "")))).join("");
}

beforeEach(() => {
	vi.useFakeTimers();
	const delivered = { deliveryId: "d", backend: "tmux", paneId: PANE, status: "delivered", acceptedThrough: 1 } as const;
	vi.mocked(sendPaneInput).mockResolvedValue(delivered);
	vi.mocked(deliverPaneInput).mockResolvedValue(delivered);
});

afterEach(() => {
	resetAgentMessageHolds();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("a burst of dev3 messages keeps its boundaries", () => {
	it("separates two envelopes with a blank line instead of welding them", async () => {
		await holdMessageForPane(task, PANE, envelope("first report", 1));
		await holdMessageForPane(task, PANE, envelope("second report", 2));
		await vi.runAllTimersAsync();

		const typed = typedText();
		expect(typed).toContain("</dev3-ai-message>\n\n<dev3-ai-message>");
		expect(typed).not.toContain("</dev3-ai-message><dev3-ai-message>");
	});

	it("opens the turn with the message itself, never with a leading blank line", async () => {
		await holdMessageForPane(task, PANE, envelope("only report", 1));
		await vi.runAllTimersAsync();

		expect(typedText().startsWith("<dev3-ai-message>")).toBe(true);
	});

	it("keeps every boundary in a three-message burst", async () => {
		for (const seq of [1, 2, 3]) await holdMessageForPane(task, PANE, envelope(`report ${seq}`, seq));
		await vi.runAllTimersAsync();

		const typed = typedText();
		expect(typed.split("</dev3-ai-message>\n\n<dev3-ai-message>")).toHaveLength(3);
		expect(typed).not.toContain("</dev3-ai-message><dev3-ai-message>");
	});

	it("puts the board snapshot behind the same blank line", async () => {
		await holdMessageForPane(task, PANE, envelope("first report", 1), async () => "<dev3-board>…</dev3-board>");
		await vi.runAllTimersAsync();

		expect(typedText()).toContain("</dev3-ai-message>\n\n<dev3-board>");
	});
});
