import { describe, it, expect, vi, beforeEach } from "vitest";

const sendRequest = vi.fn();
vi.mock("../socket-client", () => ({ sendRequest: (...a: unknown[]) => sendRequest(...a) }));

const { handleBoardHook } = await import("../commands/hook-board");

const context = { taskId: "t1", projectId: "p1" } as never;

let stdout: string;
let stderr: string;

beforeEach(() => {
	sendRequest.mockReset();
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
});

describe("dev3 hook board", () => {
	it("prints the snapshot the server returned", async () => {
		sendRequest.mockResolvedValue({ ok: true, data: { text: "<dev3-board>\nrows\n</dev3-board>" } });

		await handleBoardHook("/tmp/sock", context);

		expect(stdout).toContain("<dev3-board>");
		expect(stdout.endsWith("\n")).toBe(true);
	});

	// The server answers empty for every task that is not a coordinator, which is
	// what lets the hook be installed unconditionally.
	it("prints nothing when the server answers with an empty snapshot", async () => {
		sendRequest.mockResolvedValue({ ok: true, data: { text: "" } });

		await handleBoardHook("/tmp/sock", context);

		expect(stdout).toBe("");
	});

	// Claude treats a non-zero UserPromptSubmit hook as a BLOCKING error and
	// erases the user's prompt, so every failure below must stay silent and
	// successful. A missing board is never worth a lost prompt.
	it("stays silent when the socket call throws", async () => {
		sendRequest.mockRejectedValue(new Error("app is not running"));

		await expect(handleBoardHook("/tmp/sock", context)).resolves.toBeUndefined();

		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("stays silent when the server reports a failure", async () => {
		sendRequest.mockResolvedValue({ ok: false, error: "boom" });

		await handleBoardHook("/tmp/sock", context);

		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("stays silent when the response carries no usable text", async () => {
		sendRequest.mockResolvedValue({ ok: true, data: { text: 42 } });

		await handleBoardHook("/tmp/sock", context);

		expect(stdout).toBe("");
	});

	it("does not call the socket at all outside a task worktree", async () => {
		await handleBoardHook("/tmp/sock", null);
		await handleBoardHook(null, context);

		expect(sendRequest).not.toHaveBeenCalled();
		expect(stdout).toBe("");
	});

	// A board is worth less than a fast turn; the hook must not sit on its own
	// timeout waiting for a busy app.
	it("asks the server with a bounded timeout and a retry", async () => {
		sendRequest.mockResolvedValue({ ok: true, data: { text: "" } });

		await handleBoardHook("/tmp/sock", context);

		expect(sendRequest.mock.calls[0][1]).toBe("board.snapshot");
		expect(sendRequest.mock.calls[0][2]).toEqual({ taskId: "t1", projectId: "p1" });
		expect(sendRequest.mock.calls[0][3]).toMatchObject({ timeoutMs: 3_000, connectAttempts: 2 });
	});
});
