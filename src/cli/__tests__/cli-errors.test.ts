import { describe, expect, it } from "vitest";
import { classifyAppError } from "../../shared/cli-errors";
import { CLI_EXIT_CODE_DEFINITIONS } from "../../shared/cli-exit-codes";
import { EVENT_CURSOR_UNRESOLVED_PREFIX } from "../../shared/board-events";
import { SENDER_INBOX_BUSY_ERROR, UNKNOWN_EXTERNAL_SENDER_ERROR } from "../../shared/external-senders";
import { DRAFT_TASK_ACTIVATION_ERROR, TASK_REF_UNRESOLVED_PREFIX } from "../../shared/types";

const SAMPLES: Array<[string, string, number]> = [
	[`Error: ${TASK_REF_UNRESOLVED_PREFIX}No PR #9`, "TASK_REF_UNRESOLVED", 18],
	[`${EVENT_CURSOR_UNRESOLVED_PREFIX}gone\nhint`, "EVENT_CURSOR_INVALID", 19],
	[`${UNKNOWN_EXTERNAL_SENDER_ERROR} "x".`, "EXTERNAL_SENDER_UNKNOWN", 39],
	[`${SENDER_INBOX_BUSY_ERROR}: held`, "SENDER_INBOX_BUSY", 40],
	[`Cannot start: ${DRAFT_TASK_ACTIVATION_ERROR}`, "TASK_IS_DRAFT", 9],
	["anything else", "COMMAND_FAILED", 1],
];

describe("classifyAppError", () => {
	it.each(SAMPLES)("maps %j to %s", (error, code, exitCode) => {
		const got = classifyAppError(error);
		expect(got.code).toBe(code);
		expect(got.exitCode).toBe(exitCode);
	});

	it("cuts a marker prefix off the message", () => {
		expect(classifyAppError(`x ${TASK_REF_UNRESOLVED_PREFIX}No PR #9`).message).toBe("No PR #9");
	});

	it("only produces documented exit codes", () => {
		const documented = new Set<number>(CLI_EXIT_CODE_DEFINITIONS.map((d) => d.code));
		for (const [error] of SAMPLES) expect(documented.has(classifyAppError(error).exitCode)).toBe(true);
	});
});
