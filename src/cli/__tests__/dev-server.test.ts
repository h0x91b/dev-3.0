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
	devPorts: [{ port: 5173, pid: 81298, processName: "bun" }],
	portConflicts: [],
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
		}, { retryEmptyResponse: true });
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
		}, { retryEmptyResponse: true });
	});

	// Regression: `dev3 dev-server status` used to crash with
	// "undefined is not an object (evaluating 'ports.length')" when a CLI newer
	// than the running app received a status payload missing the array fields the
	// older backend never sent (`devPorts`/`portConflicts`, added after v1.27.4).
	it("renders a clean stopped status when the backend omits newer array fields", async () => {
		// Shape produced by a pre-v1.27.4 backend: no devPorts / portConflicts.
		const legacyStopped = {
			projectId: "proj-001",
			taskId: "aaaaaaaa-1111-2222-3333-444444444444",
			running: false,
			hasDevScript: true,
			worktreePath: "/tmp/worktrees/proj/aaaaaaaa/worktree",
			tmuxSocket: "dev3",
			taskSessionName: "dev3-aaaaaaaa",
			devSessionName: "dev3-dev-aaaaaaaa",
			viewerPaneId: null,
			panePids: [],
			assignedPorts: [],
			ports: [],
			resourceUsage: undefined,
		};
		mockSend.mockResolvedValue(okResp(legacyStopped));

		await expect(
			handleDevServer("status", { positional: [], flags: {} }, SOCKET, CTX),
		).resolves.toBeUndefined();

		expect(stdoutOutput).toContain("Dev server is stopped");
		expect(stdoutOutput).toContain("Detected Ports:");
		expect(stdoutOutput).toContain("Dev Ports:");
		expect(stdoutOutput).toContain("(none detected)");
		expect(stdoutOutput).not.toContain("WARNING: port");
	});
});

describe("dev-server start/stop/restart", () => {
	it("starts the dev server from context", async () => {
		mockSend.mockResolvedValue(okResp(STATUS));

		await handleDevServer("start", { positional: [], flags: {} }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "devServer.start", {
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		}, { retryEmptyResponse: true });
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
		}, { retryEmptyResponse: true });
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
		}, { retryEmptyResponse: true });
		expect(stdoutOutput).toContain("Restarted dev server");
	});
});

describe("dev-server port conflicts", () => {
	it("prints a warning for each conflicting port holder", async () => {
		mockSend.mockResolvedValue(okResp({
			...STATUS,
			portConflicts: [
				{ port: 50001, pid: 999, processName: "node" },
				{ port: 55930, pid: 1001, processName: "python3" },
			],
		}));

		await handleDevServer("status", { positional: [], flags: {} }, SOCKET, CTX);

		expect(stdoutOutput).toContain("WARNING: port 50001 is already in use by node (pid 999)");
		expect(stdoutOutput).toContain("WARNING: port 55930 is already in use by python3 (pid 1001)");
	});

	it("prints no warnings when there are no conflicts", async () => {
		mockSend.mockResolvedValue(okResp(STATUS));

		await handleDevServer("status", { positional: [], flags: {} }, SOCKET, CTX);

		expect(stdoutOutput).not.toContain("WARNING: port");
	});
});

describe("dev-server start --wait", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls status until the dev server opens a port, then prints Ready", async () => {
		vi.useFakeTimers();
		let statusCalls = 0;
		mockSend.mockImplementation(async (_socket: string, method: string) => {
			if (method === "devServer.start") return okResp({ ...STATUS, devPorts: [] });
			statusCalls++;
			return okResp(statusCalls >= 2 ? STATUS : { ...STATUS, devPorts: [] });
		});

		const promise = handleDevServer("start", { positional: [], flags: { wait: "true" } }, SOCKET, CTX);
		await vi.advanceTimersByTimeAsync(1000);
		await promise;

		expect(statusCalls).toBe(2);
		expect(stdoutOutput).toContain("Ready: listening on 5173");
	});

	it("exits with an error when the timeout elapses before a port appears", async () => {
		vi.useFakeTimers();
		mockSend.mockImplementation(async (_socket: string, method: string) => {
			if (method === "devServer.restart") return okResp({ ...STATUS, devPorts: [] });
			return okResp({ ...STATUS, devPorts: [] });
		});

		const promise = handleDevServer(
			"restart",
			{ positional: [], flags: { wait: "true", timeout: "1" } },
			SOCKET,
			CTX,
		).catch((err: Error) => err);
		await vi.advanceTimersByTimeAsync(5000);
		const err = await promise;

		expect(String(err)).toContain("EXIT_1");
		expect(stderrOutput).toContain("did not open a port within 1s");
	});

	it("exits with an error when the dev server dies while waiting", async () => {
		mockSend.mockImplementation(async (_socket: string, method: string) => {
			if (method === "devServer.start") return okResp({ ...STATUS, devPorts: [] });
			return okResp({ ...STATUS, running: false, devPorts: [] });
		});

		await expect(
			handleDevServer("start", { positional: [], flags: { wait: "true" } }, SOCKET, CTX),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("exited before opening a port");
	});

	it("rejects an invalid --timeout value", async () => {
		mockSend.mockResolvedValue(okResp({ ...STATUS, devPorts: [] }));

		await expect(
			handleDevServer("start", { positional: [], flags: { wait: "true", timeout: "zero" } }, SOCKET, CTX),
		).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Invalid --timeout value");
	});

	it("does not poll when --wait is not passed", async () => {
		mockSend.mockResolvedValue(okResp({ ...STATUS, devPorts: [] }));

		await handleDevServer("start", { positional: [], flags: {} }, SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(stdoutOutput).not.toContain("Waiting for the dev server");
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
