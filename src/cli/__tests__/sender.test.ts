import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSender } from "../commands/sender";
import type { CliContext } from "../context";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const IN_TASK: CliContext = { projectId: "p", taskId: "aaaaaaaa-1111-2222-3333-444444444444", socketPath: SOCKET };

let stdout = "";
let exitSpy: ReturnType<typeof vi.spyOn>;
let spies: Array<ReturnType<typeof vi.spyOn>> = [];

const ok = (data: unknown): CliResponse => ({ id: "t", ok: true, data });
const fail = (error: string): CliResponse => ({ id: "t", ok: false, error });

beforeEach(() => {
	stdout = "";
	mockSend.mockReset();
	spies = [
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		}),
		vi.spyOn(process.stderr, "write").mockImplementation(() => true),
	];
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
	for (const spy of spies) spy.mockRestore();
	exitSpy.mockRestore();
});

describe("dev3 sender inbox", () => {
	it("long-polls with the lease and prints the result as JSON", async () => {
		const result = { items: [{ id: "i1", body: "done" }], cursor: "2026-10-26:120", more: false };
		mockSend.mockResolvedValue(ok(result));
		await handleSender("inbox", { positional: [], flags: { "as-sender": "openclaw:home:main", wait: "25", client: "c1", json: "true" } }, SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "sender.wait", {
			senderId: "openclaw:home:main",
			cursor: null,
			timeoutMs: 25_000,
			clientId: "c1",
		}, { timeoutMs: 30_000 });
		expect(JSON.parse(stdout)).toEqual(result);
	});

	it("refuses a wait past 25 s: the socket client gives up at 30", async () => {
		await expect(handleSender("inbox", { positional: [], flags: { "as-sender": "cli", wait: "26" } }, SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("exits 40 when another client holds the lease", async () => {
		mockSend.mockResolvedValue(fail('Sender inbox busy: client "c0" is reading …'));
		await expect(handleSender("inbox", { positional: [], flags: { "as-sender": "cli", client: "c1" } }, SOCKET, null)).rejects.toThrow("EXIT_40");
	});

	it("exits 39 for an unregistered sender", async () => {
		mockSend.mockResolvedValue(fail('Unknown external sender "cli". Register it …'));
		await expect(handleSender("inbox", { positional: [], flags: { "as-sender": "cli" } }, SOCKET, null)).rejects.toThrow("EXIT_39");
	});

	it("is refused inside a task worktree", async () => {
		await expect(handleSender("inbox", { positional: [], flags: { "as-sender": "cli" } }, SOCKET, IN_TASK)).rejects.toThrow("EXIT_3");
	});
});

describe("dev3 sender ack", () => {
	it("sends the ids with the client and prints what was acknowledged", async () => {
		mockSend.mockResolvedValue(ok({ senderId: "cli", acked: ["i1"], unknown: ["i0"] }));
		await handleSender("ack", { positional: ["i1", "i0"], flags: { "as-sender": "cli", client: "c1", json: "true" } }, SOCKET, null);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "sender.ack", { senderId: "cli", clientId: "c1", ids: ["i1", "i0"] });
		expect(JSON.parse(stdout)).toEqual({ acked: ["i1"], unknown: ["i0"] });
	});

	it("needs --client: an ack belongs to the lease holder", async () => {
		await expect(handleSender("ack", { positional: ["i1"], flags: { "as-sender": "cli" } }, SOCKET, null)).rejects.toThrow("EXIT_3");
	});
});
