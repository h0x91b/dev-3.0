import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleVents } from "../commands/vents";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
}

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
		throw new Error(`EXIT_${_code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("dev3 vents", () => {
	it("sends name + content from positionals", async () => {
		mockSend.mockResolvedValue(okResp({ fileName: "2026-06-15_14-30_cli-confusing.md" }));

		await handleVents(args(["cli confusing", "The `dev3 vents` flags are unclear."]), SOCKET);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "vent.add", {
			name: "cli confusing",
			content: "The `dev3 vents` flags are unclear.",
		});
		expect(stdoutOutput).toContain("Vent recorded");
		expect(stdoutOutput).toContain("2026-06-15_14-30_cli-confusing.md");
	});

	it("accepts --name and --content flags", async () => {
		mockSend.mockResolvedValue(okResp({ fileName: "x.md" }));

		await handleVents(args([], { name: "flag name", content: "flag body" }), SOCKET);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "vent.add", {
			name: "flag name",
			content: "flag body",
		});
	});

	it("errors on missing name", async () => {
		await expect(handleVents(args([], { content: "body only" }), SOCKET)).rejects.toThrow(/EXIT_/);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("errors on missing content", async () => {
		await expect(handleVents(args(["name only"]), SOCKET)).rejects.toThrow(/EXIT_/);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects unknown flags", async () => {
		await expect(handleVents(args(["n", "b"], { bogus: "1" }), SOCKET)).rejects.toThrow(/EXIT_/);
	});

	it("surfaces a server error", async () => {
		mockSend.mockResolvedValue(errResp("boom"));
		await expect(handleVents(args(["n", "b"]), SOCKET)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("boom");
	});
});
