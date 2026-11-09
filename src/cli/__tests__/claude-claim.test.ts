import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { claimedFilePath, handleClaudeClaim } from "../commands/claude-claim";
import { sendRequest } from "../socket-client";

const mockSend = vi.mocked(sendRequest);
const CTX = { projectId: "p1", taskId: "t1", socketPath: "/tmp/s.sock" };
let stdout = "";

function payload(input: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd: "/home/me/notes", session_id: "s1", tool_input: input, ...extra });
}

beforeEach(() => {
	stdout = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (stdout += String(chunk), true));
});

afterEach(() => {
	vi.restoreAllMocks();
	mockSend.mockReset();
});

describe("claimedFilePath", () => {
	it("reads Edit, Write and NotebookEdit targets and resolves a relative one against cwd", () => {
		expect(claimedFilePath(payload({ file_path: "/home/me/notes/a.md" }))?.path).toBe("/home/me/notes/a.md");
		expect(claimedFilePath(payload({ notebook_path: "nb.ipynb" }))?.path).toBe("/home/me/notes/nb.ipynb");
	});

	it("ignores other events and payloads without a path", () => {
		expect(claimedFilePath(payload({ file_path: "/a" }, { hook_event_name: "PostToolUse" }))).toBeNull();
		expect(claimedFilePath(payload({ command: "ls" }))).toBeNull();
		expect(claimedFilePath("not json")).toBeNull();
	});
});

describe("handleClaudeClaim", () => {
	it("denies the edit with the holder's name and the message to send it", async () => {
		mockSend.mockResolvedValue({ id: "x", ok: true, data: { conflict: {
			path: "/home/me/notes/a.md", fileName: "a.md", holderTaskId: "t2", holderSeq: 12, holderTitle: "Draft ADR", minutesLeft: 7,
		} } });

		await handleClaudeClaim(payload({ file_path: "/home/me/notes/a.md" }), CTX.socketPath, CTX);

		const out = JSON.parse(stdout);
		expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain('task #12 "Draft ADR"');
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("dev3 message --task seq:12 --subject");
		expect(mockSend).toHaveBeenCalledWith(CTX.socketPath, "task.claimFile", { taskId: "t1", projectId: "p1", path: "/home/me/notes/a.md" }, expect.anything());
	});

	it("prints nothing, so the edit goes ahead, when the file is free", async () => {
		mockSend.mockResolvedValue({ id: "x", ok: true, data: { conflict: null } });
		await handleClaudeClaim(payload({ file_path: "/home/me/notes/a.md" }), CTX.socketPath, CTX);
		expect(stdout).toBe("");
	});

	it("never blocks when the app is offline", async () => {
		mockSend.mockRejectedValue(new Error("APP_NOT_RUNNING"));
		await expect(handleClaudeClaim(payload({ file_path: "/a.md" }), CTX.socketPath, CTX)).resolves.toBeUndefined();
		expect(stdout).toBe("");
	});
});
