import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleDevServer } from "../commands/dev-server";
import type { CliContext } from "../context";
import type { DevServerStatus, CliResponse } from "../../shared/types";

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
	worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
};

const STATUS: DevServerStatus = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	running: true,
	hasDevScript: true,
	worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
	tmuxSocket: "dev3",
	taskSessionName: "dev3-aaaaaaaa",
	devSessionName: "dev3-dev-aaaaaaaa",
	viewerPaneId: "%17",
	panePids: [81231],
	assignedPorts: [50001, 55930, 55937],
	ports: [{ port: 5173, pid: 81298, processName: "bun" }],
	resourceUsage: { cpu: 3.1, rss: 104857600 },
};

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
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

describe("dev-server status", () => {
	it("defaults to status when no subcommand is provided", async () => {
		mockSend.mockResolvedValue(okResp(STATUS));

		await handleDevServer(undefined, { positional: [], flags: {} }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "devServer.status", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Dev server is running");
		expect(stdoutOutput).toContain("dev3-dev-aaaaaaaa");
		expect(stdoutOutput).toContain("DEV3_PORT0=50001");
		expect(stdoutOutput).toContain("DEV3_PORT2=55937");
		expect(stdoutOutput).toContain("5173 (bun pid 81298)");
	});

	it("uses explicit task ID when provided", async () => {
		mockSend.mockResolvedValue(okResp(STATUS));

		await handleDevServer("status", { positional: ["bbbbbbbb"], flags: {} }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "devServer.status", {
			taskId: "bbbbbbbb",
			projectId: CTX.projectId,
		});
	});
});

describe("dev-server start/stop/restart", () => {
	it("starts the dev server from context", async () => {
		mockSend.mockResolvedValue(okResp(STATUS));

		await handleDevServer("start", { positional: [], flags: {} }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "devServer.start", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Started dev server");
	});

	it("stops the dev server with an explicit --project override", async () => {
		mockSend.mockResolvedValue(okResp({
			...STATUS,
			running: false,
			viewerPaneId: null,
			panePids: [],
			assignedPorts: [],
			ports: [],
			resourceUsage: undefined,
		}));

		await handleDevServer("stop", { positional: ["aaaaaaaa"], flags: { project: "other-proj" } }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "devServer.stop", {
			taskId: CTX.taskId,
			projectId: "other-proj",
		});
		expect(stdoutOutput).toContain("Stopped dev server");
		expect(stdoutOutput).toContain("stopped");
		expect(stdoutOutput).toContain("(none detected)");
	});

	it("restarts the dev server", async () => {
		mockSend.mockResolvedValue(okResp(STATUS));

		await handleDevServer("restart", { positional: [], flags: {} }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "devServer.restart", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Restarted dev server");
	});

});

describe("dev-server errors", () => {
	it("exits with usage error when no task ID and no context", async () => {
		await expect(
			handleDevServer("start", { positional: [], flags: {} }, SOCKET, null),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Usage: dev3 dev-server start");
	});

	it("exits on server error", async () => {
		mockSend.mockResolvedValue({ id: "test-id", ok: false, error: "No dev script configured" });

		await expect(
			handleDevServer("start", { positional: [], flags: {} }, SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("No dev script configured");
	});

	it("exits on unknown subcommand", async () => {
		await expect(
			handleDevServer("explode", { positional: [], flags: {} }, SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Unknown subcommand: dev-server explode");
	});
});
