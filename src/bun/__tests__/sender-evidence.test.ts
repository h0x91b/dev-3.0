import { describe, expect, it } from "vitest";
import { senderEvidenceOf } from "../sender-evidence";

describe("senderEvidenceOf", () => {
	it("reads the CLI's $TMUX and DEV3_TASK_ID when they are strings", () => {
		expect(senderEvidenceOf({ sourceTmux: "/tmp/tmux-1/dev3,42,0", sourceEnvTaskId: "t1" })).toEqual({ tmuxEnv: "/tmp/tmux-1/dev3,42,0", envTaskId: "t1" });
	});

	it("turns a number or a missing field into null", () => {
		expect(senderEvidenceOf({ sourceTmux: 42 })).toEqual({ tmuxEnv: null, envTaskId: null });
		expect(senderEvidenceOf({})).toEqual({ tmuxEnv: null, envTaskId: null });
	});
});
