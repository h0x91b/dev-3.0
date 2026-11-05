import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleBoard } from "../commands/board";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const CTX: CliContext = { projectId: "proj-001", taskId: null as unknown as string, socketPath: SOCKET };

let stdout: string;
let stderr: string;

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

beforeEach(() => {
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("dev3 board export", () => {
	it("asks the app to export the context project and reports what changed", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: { dir: "/repo/.dev3/board", taskCount: 3, written: 2, removed: 1 } });
		await handleBoard("export", args(), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "board.export", { projectId: "proj-001" });
		expect(stdout).toBe("Board copy written to /repo/.dev3/board: 3 task(s), 2 file(s) written, 1 removed\n");
	});

	it("prints the app's refusal when the copy is off", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: false, error: "The board copy is off for this project." });
		await expect(handleBoard("export", args(), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderr).toContain("The board copy is off for this project.");
	});

	it("rejects an unknown subcommand", async () => {
		await expect(handleBoard("import", args(), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderr).toContain("Available: board export");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
