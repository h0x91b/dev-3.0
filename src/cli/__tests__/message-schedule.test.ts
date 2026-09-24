import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleMessage } from "../commands/message";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const CTX: CliContext = { projectId: "proj-001", taskId: "aaaaaaaa-1111-2222-3333-444444444444", socketPath: SOCKET };
const MSG_ID = "bbbbbbbb-9999-8888-7777-666666666666";
const ok = (data: unknown): CliResponse => ({ id: "x", ok: true, data });
const args = (positional: string[], flags: Record<string, string>): ParsedArgs => ({ positional, flags });

let stdout: string;
let stderr: string;
beforeEach(() => {
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { stdout += String(c); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { stderr += String(c); return true; });
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("message --at with a zone", () => {
	it("sends the UTC instant and confirms in local AND UTC, with the cancel command", async () => {
		mockSend.mockResolvedValue(ok({ taskId: CTX.taskId, pending: 1, messageId: MSG_ID }));
		await handleMessage(args(["wake up"], { subject: "wake", at: "2099-01-02T06:00Z" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "message.schedule", expect.objectContaining({ at: "2099-01-02T06:00:00.000Z" }));
		expect(stdout).toContain("06:00 UTC");
		expect(stdout).toContain(" local (");
		expect(stdout).toContain("dev3 message --cancel bbbbbbbb --task aaaaaaaa");
	});

	it("still confirms when an older app returns no id", async () => {
		mockSend.mockResolvedValue(ok({ taskId: CTX.taskId, pending: 1 }));
		await handleMessage(args(["x"], { subject: "s", at: "06:00Z" }), SOCKET, CTX);
		expect(stdout).toContain("UTC");
		expect(stdout).not.toContain("--cancel");
	});

	it("refuses an absolute time in the past before contacting the app", async () => {
		await expect(handleMessage(args(["x"], { subject: "s", at: "2020-01-01T00:00Z" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderr).toContain("in the past");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("names every accepted spelling when the time is invalid", async () => {
		await expect(handleMessage(args(["x"], { subject: "s", at: "6pm" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderr).toMatch(/HH:MMZ.*HH:MM\+03:00/);
	});
});

describe("message --list / --cancel", () => {
	const listing = {
		taskId: CTX.taskId,
		seq: 7,
		messages: [{ id: MSG_ID, at: "2099-01-02T06:00:00.000Z", subject: "wake", target: "agent", fromSeq: 12, fromTaskId: "t", preview: "wake up" }],
	};

	it("lists the worktree task's queue without needing text or a subject", async () => {
		mockSend.mockResolvedValue(ok(listing));
		await handleMessage(args([], { list: "true" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "message.scheduled.list", { taskId: CTX.taskId, projectId: "proj-001" });
		expect(stdout).toContain("bbbbbbbb");
		expect(stdout).toContain("seq:12");
		expect(stdout).toContain("06:00 UTC");
	});

	it("--list --json prints the listing object as is", async () => {
		mockSend.mockResolvedValue(ok(listing));
		await handleMessage(args([], { list: "true", json: "true" }), SOCKET, CTX);
		expect(JSON.parse(stdout)).toEqual(listing);
	});

	it("an empty queue says so", async () => {
		mockSend.mockResolvedValue(ok({ ...listing, messages: [] }));
		await handleMessage(args([], { list: "true" }), SOCKET, CTX);
		expect(stdout).toContain("No scheduled messages pending");
	});

	it("cancels by id prefix on the named task", async () => {
		mockSend.mockResolvedValue(ok({ taskId: "cccccccc", cancelled: listing.messages[0] }));
		await handleMessage(args([], { cancel: "bbbbbbbb", task: "seq:7" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "message.scheduled.cancel", { taskId: "seq:7", projectId: "proj-001", messageId: "bbbbbbbb" });
		expect(stdout).toContain("Cancelled scheduled message bbbbbbbb");
	});

	it("refuses --cancel with no id, and --list with --cancel", async () => {
		await expect(handleMessage(args([], { cancel: "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		await expect(handleMessage(args([], { list: "true", cancel: "x" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("reports the app's not-found error instead of claiming success", async () => {
		mockSend.mockResolvedValue({ id: "x", ok: false, error: "No pending scheduled message zzz on this task (it may have fired already)." });
		await expect(handleMessage(args([], { cancel: "zzz" }), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(stderr).toContain("may have fired already");
		expect(stdout).not.toContain("Cancelled");
	});
});
