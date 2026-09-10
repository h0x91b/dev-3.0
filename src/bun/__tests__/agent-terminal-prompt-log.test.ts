/**
 * Recording a terminal submission as the user's — read back off a real log file,
 * never asserted against the writer.
 *
 * Every suppression case here is a way dev3 itself causes a `UserPromptSubmit`:
 * a peer message, the Send-to-agent and Send-later paths (which write their own
 * row already), a held burst, and the task brief handed over as a launch
 * argument. If any of them starts producing a row, the traffic graph gains a
 * human who never typed, or counts one message twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-termprompt-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home, OPS_DIR: `${home}/ops`, SANDBOX_DIR: `${home}/sandbox` }));
vi.mock("../git", () => ({
	projectSlug: (p: string) => p.replace(/^\//, "").replaceAll("/", "-"),
}));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: vi.fn(() => vi.fn()) }));
vi.mock("../agent-message-log-watch", () => ({ noteLocalMessageLogAppend: vi.fn() }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { Project, Task } from "../../shared/types";
import { isUserOrigin } from "../../shared/agent-message-log";
import { AGENT_MESSAGE_BURST_SEPARATOR, wrapAgentMessage } from "../../shared/agent-message-envelope";
import { TERMINAL_PROMPT_PREVIEW_MAX_CHARS } from "../../shared/agent-terminal-prompt";
import { messageLogDir, readAgentMessageLog, resetAgentMessageLogPruneState } from "../agent-message-log";
import { noteDev3TypedPrompt, resetTypedPromptClaims } from "../agent-typed-prompt-claims";
import { recordTerminalPromptSubmission, resetPromptSubmissionMemory } from "../agent-terminal-prompt-log";

const project = { id: "proj-1", name: "Proj", path: "/Users/x/repo" } as unknown as Project;
const task = { id: "task-12345678", projectId: "proj-1", seq: 1848, title: "Worker" } as unknown as Task;

function submit(prompt: string, overrides: Record<string, unknown> = {}) {
	return recordTerminalPromptSubmission({
		project,
		task,
		harness: "claude",
		prompt,
		sessionId: "session-1",
		submissionId: `prompt-${Math.random()}`,
		...overrides,
	});
}

function rows() {
	return readAgentMessageLog(project).rows;
}

beforeEach(() => {
	rmSync(messageLogDir(project), { recursive: true, force: true });
	resetAgentMessageLogPruneState();
	resetTypedPromptClaims();
	resetPromptSubmissionMemory();
});

describe("a prompt dev3 did not cause", () => {
	it("is written as the user's, addressed to the task whose pane it was typed in", () => {
		expect(submit("please rebase this branch")).toBe("recorded");

		const [row] = rows();
		expect(row).toBeDefined();
		expect(isUserOrigin(row!)).toBe(true);
		expect(row!.fromTaskId).toBeNull();
		expect(row!.toTaskId).toBe(task.id);
		expect(row!.toSeq).toBe(1848);
		expect(row!.body).toBe("please rebase this branch");
	});

	it("stores a preview, never the prompt", () => {
		submit(`${"x".repeat(500)} SECRET-TAIL`);

		const [row] = rows();
		expect(row!.body.length).toBeLessThanOrEqual(TERMINAL_PROMPT_PREVIEW_MAX_CHARS);
		expect(row!.body).not.toContain("SECRET-TAIL");
	});
});

describe("submissions dev3 caused", () => {
	it("does not record a peer message, which arrives wrapped", () => {
		const wrapped = wrapAgentMessage("do the thing", { taskId: "t-9", seq: 9 }, project.id, "the thing");
		expect(submit(wrapped)).toBe("envelope");
		expect(rows()).toHaveLength(0);
	});

	it("does not record the harness's own subagent-completion prompt", () => {
		// Observed on claude 2.1.267: finishing a Task subagent raises a SECOND
		// UserPromptSubmit in the same session, with its own prompt id and nothing
		// marking it as generated. dev3 typed none of it, so no receipt exists and
		// only the shape of the text can save it.
		const notification = "<task-notification>\n<task-id>a7a60b2f2e83f827c</task-id>\n<result>PONG</result>\n</task-notification>";
		expect(submit(notification)).toBe("machine-tagged");
		expect(rows()).toHaveLength(0);
	});

	it("does not record slash-command scaffolding or a reminder either", () => {
		expect(submit("<command-name>/review</command-name>\nrun it")).toBe("machine-tagged");
		expect(submit("<system-reminder>the plan is stale</system-reminder>")).toBe("machine-tagged");
		expect(rows()).toHaveLength(0);
	});

	it("still records a human prompt that merely contains a tag further in", () => {
		expect(submit("why does <task-notification> keep showing up?")).toBe("recorded");
		expect(rows()).toHaveLength(1);
	});

	it("does not record what a UI send typed, so the row that path already wrote is not doubled", () => {
		// sendAgentMessageNow / scheduleMessage both go through deliverAgentPrompt,
		// which leaves this receipt, and both write their own row with origin "user".
		noteDev3TypedPrompt(task.id, "Please look at this diff hunk");
		expect(submit("Please look at this diff hunk")).toBe("dev3-typed");
		expect(rows()).toHaveLength(0);
	});

	it("does not record the task brief handed over as a launch argument", () => {
		noteDev3TypedPrompt(task.id, "Record terminal user messages reliably, without duplicates.");
		const asSubmitted = "Record terminal user messages reliably, without duplicates.\n\n# dev3 — Task Lifecycle Protocol\n…";
		expect(submit(asSubmitted)).toBe("dev3-typed");
		expect(rows()).toHaveLength(0);
	});

	it("does not record a held burst, composed of several deliveries plus a trailer", () => {
		noteDev3TypedPrompt(task.id, "first peer body, long enough to match");
		noteDev3TypedPrompt(task.id, "second peer body, long enough to match");
		const composed = [
			"first peer body, long enough to match",
			"second peer body, long enough to match",
			"<dev3-board>snapshot</dev3-board>",
		].join(AGENT_MESSAGE_BURST_SEPARATOR);
		expect(submit(composed)).toBe("dev3-typed");
		expect(rows()).toHaveLength(0);
	});

	it("records the human's next prompt after a receipt was spent", () => {
		noteDev3TypedPrompt(task.id, "a peer message with enough length");
		expect(submit("a peer message with enough length")).toBe("dev3-typed");
		expect(submit("now do what it said")).toBe("recorded");
		expect(rows()).toHaveLength(1);
	});
});

describe("exactly once", () => {
	it("writes one row when the same submission is reported twice", () => {
		expect(submit("ship it", { submissionId: "prompt-7" })).toBe("recorded");
		expect(submit("ship it", { submissionId: "prompt-7" })).toBe("duplicate");
		expect(rows()).toHaveLength(1);
	});

	it("writes two rows for two submissions of the same text", () => {
		submit("again", { submissionId: "prompt-1" });
		submit("again", { submissionId: "prompt-2" });
		expect(rows()).toHaveLength(2);
	});

	it("refuses to record when the harness identified nothing", () => {
		expect(submit("who sent this", { sessionId: null, submissionId: null })).toBe("unidentified");
		expect(rows()).toHaveLength(0);
	});

	it("ignores an empty submission", () => {
		expect(submit("   ")).toBe("empty");
		expect(rows()).toHaveLength(0);
	});
});
