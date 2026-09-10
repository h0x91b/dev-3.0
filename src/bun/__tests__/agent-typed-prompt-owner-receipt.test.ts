/**
 * A native delivery forwarded to the app process holding the pane's writer
 * lease leaves its receipt on BOTH sides.
 *
 * The sender's process decided to type and noted it there; the pane's
 * prompt-submit hook, however, reaches whichever process owns the task's CLI
 * socket. With one receipt in the wrong process, a forwarded peer message is
 * recorded as something the user typed — the one attribution failure this
 * feature must not have. Own file because the callsite suite mocks this module
 * away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-prompt", () => ({ scheduleAgentPromptSubmit: vi.fn(), markAgentPane: vi.fn() }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../native-pane-owner", () => ({ forwardToOwner: vi.fn(), resolvePaneOwner: vi.fn() }));
vi.mock("../native-task-panes", () => ({ nativeTaskPanesState: vi.fn() }));
vi.mock("../pty-server", () => ({
	// No terminal here: the receipt must be left before the delivery can fail,
	// because the hook fires for what was typed, not for what succeeded.
	nativePaneTerminal: vi.fn(() => null),
	ensureNativePanePtySession: vi.fn(),
	reattachNativeTaskSession: vi.fn(),
}));

import { deliverNativePromptAsOwner } from "../agent-prompt-native";
import { claimDev3TypedPrompt, resetTypedPromptClaims } from "../agent-typed-prompt-claims";

beforeEach(() => {
	resetTypedPromptClaims();
});

describe("deliverNativePromptAsOwner", () => {
	it("leaves a receipt in the process that actually types", async () => {
		await deliverNativePromptAsOwner({
			taskId: "task-1",
			paneId: "pane-1",
			text: "a forwarded peer message body",
		});

		expect(claimDev3TypedPrompt("task-1", "a forwarded peer message body")).toBe(true);
	});
});
