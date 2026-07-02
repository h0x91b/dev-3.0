import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleShowImage } from "../commands/show-image";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};

const DIR = mkdtempSync(join(tmpdir(), "dev3-showimage-cli-"));
const PNG = join(DIR, "shot.png");
writeFileSync(PNG, "PNGDATA");
const TXT = join(DIR, "notes.txt");
writeFileSync(TXT, "hi");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let stdoutOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}
function okResp(data: unknown): CliResponse {
	return { id: "t", ok: true, data };
}

beforeEach(() => {
	stdoutOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
		stdoutOutput += String(c);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("show-image", () => {
	it("sends resolved absolute paths for the in-context task", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));

		await handleShowImage(args([PNG]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.show-image", {
			taskId: CTX.taskId,
			paths: [PNG],
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Shared 1 image");
	});

	it("passes a caption when given", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, stored: 1, taskId: CTX.taskId }));
		await handleShowImage(args([PNG], { caption: "login screen" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"ui.show-image",
			expect.objectContaining({ caption: "login screen" }),
		);
	});

	it("reports focus-mode suppression", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: false, suppressed: true, stored: 2, taskId: CTX.taskId }));
		await handleShowImage(args([PNG]), SOCKET, CTX);
		expect(stdoutOutput).toContain("focus mode is on");
	});

	it("errors with a usage code when no paths are given", async () => {
		await expect(handleShowImage(args([]), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects a missing file", async () => {
		await expect(handleShowImage(args([join(DIR, "gone.png")]), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an unsupported type", async () => {
		await expect(handleShowImage(args([TXT]), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("requires a task in context", async () => {
		await expect(handleShowImage(args([PNG]), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
