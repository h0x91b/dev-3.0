/**
 * The receipts are only as complete as the places that leave them.
 *
 * `deliverAgentPrompt` is the one seam every dev3-caused prompt passes through —
 * peer messages, the Send-to-agent and Send-later paths, hand-offs, held bursts.
 * If it stops leaving a receipt, every one of those is recorded as something the
 * user typed, silently and on every send. So this drives the real function and
 * reads the receipt back.
 *
 * The launch argument is the other source, and it does not pass through that
 * seam. Its wiring is asserted at the end as a deletion guard: proof that the
 * call is still there, not proof that it fires — the behaviour it produces is
 * covered in `agent-terminal-prompt-log.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../agent-hooks-refresh", () => ({ refreshClaudeHooksForTask: vi.fn(async () => {}) }));
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => ({ status: "delivered", deliveryId: "d", backend: "tmux", paneId: "%1", retryableAsNewDelivery: false })),
	sendPromptToPane: vi.fn(async () => ({ status: "delivered", deliveryId: "d", backend: "tmux", paneId: "%1", retryableAsNewDelivery: false })),
	holdMessageForAgentPane: vi.fn(async () => ({ status: "held" })),
	holdMessageForPane: vi.fn(async () => ({ status: "held" })),
}));
vi.mock("../agent-prompt-native", () => ({
	sendPromptToNativeAgentPane: vi.fn(async () => ({ status: "unconfirmed" })),
	sendPromptToNativePane: vi.fn(async () => ({ status: "unconfirmed" })),
}));
vi.mock("../task-terminal-backend", () => ({ taskTerminalBackendIdentity: () => "tmux" }));

import type { Task } from "../../shared/types";
import { deliverAgentPrompt } from "../agent-prompt-delivery";
import { claimDev3TypedPrompt, resetTypedPromptClaims } from "../agent-typed-prompt-claims";

const task = { id: "task-1", projectId: "proj-1", seq: 1, title: "T" } as unknown as Task;

beforeEach(() => {
	resetTypedPromptClaims();
});

describe("deliverAgentPrompt", () => {
	it("leaves a receipt for the text it is about to type", async () => {
		await deliverAgentPrompt(task, "a peer message long enough to match");
		expect(claimDev3TypedPrompt(task.id, "a peer message long enough to match")).toBe(true);
	});

	it("leaves it for a HELD message too, which is typed minutes later", async () => {
		await deliverAgentPrompt(task, "a held message long enough to match", { kind: "agent" }, { hold: true });
		expect(claimDev3TypedPrompt(task.id, "a held message long enough to match")).toBe(true);
	});

	it("leaves it before the text can land, not after the send returns", async () => {
		const { sendPromptToAgentPane } = await import("../agent-prompt");
		vi.mocked(sendPromptToAgentPane).mockImplementationOnce(async () => {
			// The hook can fire while the send is still in flight.
			expect(claimDev3TypedPrompt(task.id, "typed while the send is in flight")).toBe(true);
			return { status: "delivered", deliveryId: "d", backend: "tmux", paneId: "%1", retryableAsNewDelivery: false } as never;
		});
		await deliverAgentPrompt(task, "typed while the send is in flight");
	});
});

describe("the launch argument", () => {
	it("still registers a receipt at both launch sites", () => {
		const source = readFileSync(new URL("../rpc-handlers/tmux-pty.ts", import.meta.url), "utf-8");
		// The task brief and a column agent's prompt both reach the agent as launch
		// arguments, and Claude Code fires UserPromptSubmit for them.
		expect(source.split("noteDev3TypedPrompt(").length - 1).toBe(2);
	});
});
