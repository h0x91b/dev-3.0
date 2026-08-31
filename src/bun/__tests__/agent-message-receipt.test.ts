/**
 * The receipt a long `dev3 message` carries: what a receiver holding only the END of a
 * delivery still has (issue #1608).
 *
 * Driven through `sendMessageImmediately` — the same entry point the CLI's
 * `dev3 message` goes through — rather than through the spill helper, so the envelope
 * these assertions read is the one that would actually be typed into a pane.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let taskRoot = "";

vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => []),
	getProject: vi.fn(async () => ({ id: "proj-1", name: "Proj" })),
	getTask: vi.fn(),
	updateTaskWith: vi.fn(),
}));
vi.mock("../git", () => ({ taskDir: vi.fn(() => taskRoot) }));
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => true),
	sendPromptToPane: vi.fn(async () => true),
	holdMessageForAgentPane: vi.fn(async () => ({ status: "held" })),
	holdMessageForPane: vi.fn(async () => ({ status: "held" })),
}));
vi.mock("../agent-prompt-native", () => ({
	sendPromptToNativeAgentPane: vi.fn(async () => true),
	sendPromptToNativePane: vi.fn(async () => true),
}));
vi.mock("../pty-server", () => ({ DEFAULT_TMUX_SOCKET: "dev3" }));
vi.mock("../agent-message-log", () => ({ appendAgentMessageLog: vi.fn() }));
vi.mock("../coordinator-board", () => ({ coordinatorBoardEpilogue: vi.fn(async () => "") }));
vi.mock("../rpc-handlers", () => ({
	getPushMessage: vi.fn(() => vi.fn()),
	pushCliToast: vi.fn(),
	pushCliAttention: vi.fn(),
	pushAgentMessage: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { holdMessageForAgentPane } from "../agent-prompt";
import { sendMessageImmediately } from "../scheduled-message-scheduler";
import { writeAgentMessageReceipt } from "../agent-message-spill";
import { AGENT_MESSAGE_RECEIPT_KEEP, AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES, type Task } from "../../shared/types";

const SOURCE = { taskId: "sender-1234", seq: 7, title: "Sender", projectId: "proj-1" };

function task(): Task {
	return {
		id: "task-12345678",
		projectId: "proj-1",
		seq: 42,
		title: "Receiver",
		status: "in-progress",
		sessionState: { panes: [{ paneId: "%1", agentCmd: "claude", sessionId: null, agentId: null, configId: null }] },
	} as unknown as Task;
}

/** A body of exactly `bytes` UTF-8 bytes, with a recognisable first and last line. */
function body(bytes: number): string {
	const head = "HEAD-OF-THE-MESSAGE: the ruling lives here.\n";
	const tail = "\nTAIL-OF-THE-MESSAGE.";
	return head + "filler ".repeat(Math.max(1, Math.ceil((bytes - head.length - tail.length) / 7))) + tail;
}

/** The envelope that would have been typed into the pane. */
function deliveredPrompt(): string {
	const calls = vi.mocked(holdMessageForAgentPane).mock.calls;
	return String(calls[calls.length - 1]?.[1] ?? "");
}

beforeEach(() => {
	vi.clearAllMocks();
	taskRoot = mkdtempSync(join(tmpdir(), "dev3-receipt-"));
});

afterEach(() => {
	rmSync(taskRoot, { recursive: true, force: true });
});

describe("a long agent message carries a receipt the lost head cannot take with it", () => {
	it("names the copy on the LAST line before the closing tag, and the copy is byte-exact", async () => {
		const text = body(3_000);
		await sendMessageImmediately(task(), text, null, SOURCE, { subject: "long report" });

		const prompt = deliveredPrompt();
		const lines = prompt.split("\n");
		expect(lines[lines.length - 1]).toBe("</dev3-ai-message>");
		const receiptLine = lines[lines.length - 2] ?? "";
		expect(receiptLine).toMatch(/^<full-copy>.+<\/full-copy>$/);

		const path = receiptLine.slice("<full-copy>".length, -"</full-copy>".length);
		expect(readFileSync(path, "utf8")).toBe(text);
	});

	it("survives a head cut: everything before the body can be gone and the path is still there", async () => {
		const text = body(3_000);
		await sendMessageImmediately(task(), text, null, SOURCE, { subject: "long report" });

		const prompt = deliveredPrompt();
		// What a receiver that lost its head holds: the last third of the delivery.
		const truncated = prompt.slice(Math.floor(prompt.length * 0.66));
		expect(truncated).not.toContain("<dev3-ai-message>");
		expect(truncated).not.toContain("HEAD-OF-THE-MESSAGE");
		expect(truncated).toContain("</dev3-ai-message>");
		const path = /<full-copy>(.+)<\/full-copy>/.exec(truncated)?.[1] ?? "";
		expect(readFileSync(path, "utf8")).toContain("HEAD-OF-THE-MESSAGE");
	});

	it("leaves a short message exactly as it was: no receipt line, no file", async () => {
		await sendMessageImmediately(task(), "short ruling", null, SOURCE, { subject: "short" });

		expect(deliveredPrompt()).not.toContain("<full-copy>");
		expect(existsSync(join(taskRoot, "messages", "receipts"))).toBe(false);
	});

	it("writes nothing for a human's own message — only agent traffic is wrapped", async () => {
		await sendMessageImmediately(task(), body(3_000), null, null, { subject: "typed by the user" });

		expect(deliveredPrompt()).not.toContain("<full-copy>");
		expect(existsSync(join(taskRoot, "messages", "receipts"))).toBe(false);
	});
});

describe("the receipts directory is bounded, not accumulating", () => {
	it(`keeps the newest ${AGENT_MESSAGE_RECEIPT_KEEP} and deletes the rest`, async () => {
		const dir = join(taskRoot, "messages", "receipts");
		for (let i = 0; i < AGENT_MESSAGE_RECEIPT_KEEP + 12; i += 1) {
			await writeAgentMessageReceipt(task(), `${i}:${"x".repeat(AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES)}`);
		}
		expect(readdirSync(dir).length).toBe(AGENT_MESSAGE_RECEIPT_KEEP);
	});

	it("does not reach the spill files: they live outside the receipts directory", async () => {
		await writeAgentMessageReceipt(task(), "y".repeat(AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES));
		const [name] = readdirSync(join(taskRoot, "messages", "receipts"));
		expect(name).toMatch(/^message-/);
		// The spill path is `<root>/messages/message-*.md`; pruning only ever lists
		// `<root>/messages/receipts`, so a spilled body is never a pruning candidate.
		expect(readdirSync(join(taskRoot, "messages")).filter((n) => n.endsWith(".md"))).toEqual([]);
	});

	it("a message still goes out when its receipt cannot be written", async () => {
		rmSync(taskRoot, { recursive: true, force: true });
		taskRoot = "/dev/null/not-a-directory";

		const delivery = await sendMessageImmediately(task(), body(3_000), null, SOURCE, { subject: "long report" });

		expect(delivery.status).toBe("held");
		expect(deliveredPrompt()).toContain("HEAD-OF-THE-MESSAGE");
		expect(deliveredPrompt()).not.toContain("<full-copy>");
		taskRoot = mkdtempSync(join(tmpdir(), "dev3-receipt-"));
	});
});
