import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleAutomations } from "../commands/automations";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

vi.mock("../stdin", () => ({
	readStdin: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { readStdin } from "../stdin";

const mockSend = vi.mocked(sendRequest);
const mockReadStdin = vi.mocked(readStdin);
const SOCKET = "/tmp/test.sock";

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

const AUTOMATION = {
	id: "automation-1111-2222-3333-444444444444",
	name: "Release digest",
	enabled: true,
	nextRunAt: null,
};

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	mockSend.mockReset();
	mockReadStdin.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
});

describe("automation prompt stdin", () => {
	it("reads --prompt - when creating an automation", async () => {
		const prompt = '# Release\n\nKeep **Markdown** and "quotes" intact.';
		mockReadStdin.mockResolvedValue(prompt);
		mockSend.mockResolvedValue(okResp(AUTOMATION));

		await handleAutomations(
			"create",
			args([], {
				project: "proj-001",
				name: "Release digest",
				prompt: "-",
				rrule: "FREQ=DAILY",
			}),
			SOCKET,
			null,
		);

		expect(mockReadStdin).toHaveBeenCalledOnce();
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"automations.create",
			expect.objectContaining({
				projectId: "proj-001",
				name: "Release digest",
				prompt,
				rrule: "FREQ=DAILY",
			}),
		);
	});

	it("reads --prompt - when updating an automation", async () => {
		const prompt = "Run the release checklist.\n\n- Verify the build.";
		mockReadStdin.mockResolvedValue(prompt);
		mockSend.mockResolvedValue(okResp(AUTOMATION));

		await handleAutomations(
			"update",
			args(["automation-1111"], { project: "proj-001", prompt: "-" }),
			SOCKET,
			null,
		);

		expect(mockReadStdin).toHaveBeenCalledOnce();
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "automations.update", {
			projectId: "proj-001",
			automationId: "automation-1111",
			prompt,
		});
	});
});
