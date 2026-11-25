import { describe, expect, it } from "vitest";
import { copilotStatusEvent, getAgentHookTargetStatus } from "../../shared/agent-hooks";
import { armedDraftFiresOn, type TaskStatus } from "../../shared/types";
import type { PromptSubmitHarness } from "../../shared/agent-terminal-prompt";

/**
 * An armed draft must never fire on an approval prompt (#2339): only Claude's prompts are
 * gated by the prompt ledger, so the move a PermissionRequest causes must not send it.
 */
const HARNESSES: PromptSubmitHarness[] = ["claude", "codex", "copilot", "omp", "pi", "agy"];
const WORKING: TaskStatus[] = ["in-progress", "review-by-ai"];

describe("which moves send an armed draft", () => {
	it("a PermissionRequest from a working column never fires it, for any harness (#2339)", () => {
		for (const harness of HARNESSES) {
			for (const from of WORKING) {
				const to = getAgentHookTargetStatus("PermissionRequest", from, "review-by-user");
				expect(to, `${harness} from ${from}`).toBe("user-questions");
				expect(armedDraftFiresOn(to!), `${harness} from ${from}`).toBe(false);
			}
		}
	});

	it("copilot's ask_user tool counts as a PermissionRequest and does not fire it", () => {
		const event = copilotStatusEvent("preToolUse", "ask_user");
		expect(event).toBe("PermissionRequest");
		expect(armedDraftFiresOn(getAgentHookTargetStatus(event!, "in-progress", "review-by-user")!)).toBe(false);
	});

	it("a finished turn fires it, directly or after AI Review, but not a stop that hands the turn to AI Review", () => {
		expect(armedDraftFiresOn(getAgentHookTargetStatus("Stop", "in-progress", "review-by-user")!)).toBe(true);
		expect(armedDraftFiresOn(getAgentHookTargetStatus("Stop", "review-by-ai", "review-by-user")!)).toBe(true);
		expect(armedDraftFiresOn(getAgentHookTargetStatus("Stop", "in-progress", "review-by-ai")!)).toBe(false);
	});
});
