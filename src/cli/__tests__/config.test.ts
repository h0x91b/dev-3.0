import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleConfig } from "../commands/config";
import type { CliContext } from "../context";
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

const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};

const CTX_WITH_WT: CliContext = {
	...CTX,
	worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
};

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

const EMPTY_ARGS: ParsedArgs = { positional: [], flags: {} };

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("process.exit");
	});
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

describe("config show", () => {
	it("passes worktreePath when context has it", async () => {
		mockSend.mockResolvedValue(okResp({
			settings: { setupScript: "bun install" },
			sources: { setupScript: "repo" },
			hasRepoConfig: true,
		}));

		await handleConfig("show", EMPTY_ARGS, SOCKET, CTX_WITH_WT);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"config.show",
			expect.objectContaining({
				projectId: "proj-001",
				worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
			}),
		);
	});

	it("sends undefined worktreePath when context has no worktree", async () => {
		mockSend.mockResolvedValue(okResp({
			settings: { setupScript: "" },
			sources: {},
			hasRepoConfig: false,
		}));

		await handleConfig("show", EMPTY_ARGS, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"config.show",
			expect.objectContaining({
				projectId: "proj-001",
				worktreePath: undefined,
			}),
		);
	});

	it("displays 'exists' when hasRepoConfig is true", async () => {
		mockSend.mockResolvedValue(okResp({
			settings: { setupScript: "bun install" },
			sources: { setupScript: "repo" },
			hasRepoConfig: true,
		}));

		await handleConfig("show", EMPTY_ARGS, SOCKET, CTX_WITH_WT);

		expect(stdoutOutput).toContain("exists");
	});
});

describe("config export", () => {
	it("passes worktreePath when context has it", async () => {
		mockSend.mockResolvedValue(okResp({
			path: "/tmp/worktrees/proj/aaaaaaaa/worktree/.dev3/config.json",
		}));

		await handleConfig("export", EMPTY_ARGS, SOCKET, CTX_WITH_WT);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"config.export",
			expect.objectContaining({
				projectId: "proj-001",
				worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
			}),
		);
	});

	it("sends undefined worktreePath when not in a worktree", async () => {
		mockSend.mockResolvedValue(okResp({
			path: "/project/.dev3/config.json",
		}));

		await handleConfig("export", EMPTY_ARGS, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"config.export",
			expect.objectContaining({
				projectId: "proj-001",
				worktreePath: undefined,
			}),
		);
	});
});
