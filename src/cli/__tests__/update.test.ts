import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleUpdate } from "../commands/update";
import type { ParsedArgs } from "../args";
import { CLI_EXIT_CODE_COMMAND_FAILED, CLI_EXIT_CODE_UPDATE_REFUSED } from "../../shared/cli-exit-codes";
import type { RemoteServerState } from "../../shared/types";

/**
 * `dev3 update`'s own job is a routing decision — check / dry-run / delegate to a
 * running server / do it here — so the engine and the lifecycle state file are the
 * two boundaries to mock. Everything the planner decides is tested for real in
 * `src/bun/__tests__/self-update.test.ts`.
 */
vi.mock("../../bun/self-update", () => ({
	buildPlan: vi.fn(),
	runSelfUpdate: vi.fn(),
	readSuperviseJob: vi.fn(),
	runSupervisor: vi.fn(),
}));
vi.mock("../../bun/settings", () => ({
	loadSettings: vi.fn(async () => ({ updateChannel: "stable" })),
}));
vi.mock("../../bun/remote-state", () => ({
	readRemoteState: vi.fn(),
	isProcessAlive: vi.fn(),
}));
vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { buildPlan, runSelfUpdate } from "../../bun/self-update";
import { readRemoteState, isProcessAlive } from "../../bun/remote-state";
import { sendRequest } from "../socket-client";

const mockBuildPlan = vi.mocked(buildPlan);
const mockRunSelfUpdate = vi.mocked(runSelfUpdate);
const mockReadState = vi.mocked(readRemoteState);
const mockIsAlive = vi.mocked(isProcessAlive);
const mockSendRequest = vi.mocked(sendRequest);

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

function liveState(): RemoteServerState {
	return {
		pid: 4242,
		port: 41234,
		socketPath: "/tmp/dev3-test.sock",
		tunnelRequested: true,
		staticCode: null,
		logFile: null,
		startedAt: new Date().toISOString(),
		version: "1.45.0",
	};
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const exitCodes: number[] = [];

function stdout(): string {
	return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}
function stderr(): string {
	return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

beforeEach(() => {
	exitCodes.length = 0;
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error("__exit__");
	}) as never);
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	mockBuildPlan.mockReset();
	mockRunSelfUpdate.mockReset();
	mockReadState.mockReset();
	mockIsAlive.mockReset();
	mockSendRequest.mockReset();
});

afterEach(() => {
	exitSpy.mockRestore();
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	vi.clearAllMocks();
});

describe("dev3 update --help / flag validation", () => {
	it("prints its own help without touching the engine", async () => {
		await handleUpdate(args({ help: "true" }));
		expect(stdout()).toContain("dev3 update — install a newer dev3");
		expect(mockBuildPlan).not.toHaveBeenCalled();
	});

	it("rejects an unknown flag", async () => {
		await expect(handleUpdate(args({ force: "true" }))).rejects.toThrow("__exit__");
		expect(stderr()).toContain("force");
	});

	it("rejects a positional argument", async () => {
		await expect(handleUpdate(args({}, ["now"]))).rejects.toThrow("__exit__");
		expect(stderr()).toContain("Unknown positional");
	});

	it("rejects --check together with --dry-run", async () => {
		await expect(handleUpdate(args({ check: "true", "dry-run": "true" }))).rejects.toThrow("__exit__");
		expect(stderr()).toContain("one or the other");
	});
});

describe("dev3 update --dry-run", () => {
	it("prints the detected install method and what it would run, and changes nothing", async () => {
		mockBuildPlan.mockResolvedValue({
			install: "brew-formula",
			runningVersion: "1.45.0",
			plan: { kind: "brew", version: "1.45.2", cask: false, command: ["brew", "upgrade", "dev3"] },
			summary: "Detected brew-formula; would run `brew upgrade dev3` to install 1.45.2.",
		});

		await expect(handleUpdate(args({ "dry-run": "true" }))).rejects.toThrow("__exit__");

		const out = stdout();
		expect(out).toContain("Install method: brew-formula");
		expect(out).toContain("brew upgrade dev3");
		expect(exitCodes).toEqual([0]);
		expect(mockRunSelfUpdate).not.toHaveBeenCalled();
	});

	it("exits with the refusal code and prints the reason, so a wrong detection is one command away", async () => {
		mockBuildPlan.mockResolvedValue({
			install: "app-bundle",
			runningVersion: "1.45.1",
			plan: { kind: "refused", reason: "Homebrew recorded 1.44.0 for the cask but this server is running 1.45.1" },
			summary: "Detected app-bundle; refusing: Homebrew recorded 1.44.0 for the cask but this server is running 1.45.1",
		});

		await expect(handleUpdate(args({ "dry-run": "true" }))).rejects.toThrow("__exit__");

		expect(stdout()).toContain("Homebrew recorded 1.44.0");
		expect(exitCodes).toEqual([CLI_EXIT_CODE_UPDATE_REFUSED]);
	});
});

describe("dev3 update --check", () => {
	it("names the available version without installing it", async () => {
		mockBuildPlan.mockResolvedValue({
			install: "tarball",
			runningVersion: "1.45.0",
			plan: { kind: "tarball", version: "1.45.2", url: "https://example.test/dev3-cli-linux-x64.tar.gz" },
			summary: "Detected tarball; would download and extract …",
		});

		await expect(handleUpdate(args({ check: "true" }))).rejects.toThrow("__exit__");

		expect(stdout()).toContain("Available:      1.45.2");
		expect(exitCodes).toEqual([0]);
		expect(mockRunSelfUpdate).not.toHaveBeenCalled();
	});

	it("says none when there is nothing newer", async () => {
		mockBuildPlan.mockResolvedValue({
			install: "tarball",
			runningVersion: "1.45.2",
			plan: { kind: "up-to-date", version: "1.45.2" },
			summary: "Already on the current build (1.45.2); nothing to do.",
		});

		await expect(handleUpdate(args({ check: "true" }))).rejects.toThrow("__exit__");

		expect(stdout()).toContain("Available:      none");
		expect(exitCodes).toEqual([0]);
	});
});

describe("--check / --dry-run with a running headless server", () => {
	// Both flags used to plan LOCALLY, so they classified the CLI's own path. On any
	// machine the desktop app has ever started, `which dev3` is the app-maintained
	// PATH copy — which the planner refuses — so `--dry-run` reported "nothing was
	// touched, exit 15" on a box where a plain `dev3 update` updates fine.
	it("asks the server for the plan instead of classifying its own binary", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(true);
		mockSendRequest.mockResolvedValue({
			id: "1",
			ok: true,
			data: {
				install: "brew-formula",
				kind: "brew",
				runningVersion: "1.45.0",
				channel: "stable",
				version: "1.46.0",
				message: "Detected brew-formula; would run `brew upgrade dev3` to install 1.46.0.",
			},
		});

		await expect(handleUpdate(args({ check: "true" }))).rejects.toThrow("__exit__");

		expect(mockSendRequest).toHaveBeenCalledWith(
			"/tmp/dev3-test.sock",
			"remote.selfUpdate",
			{ dryRun: true },
		);
		expect(mockBuildPlan).not.toHaveBeenCalled();
		const out = stdout();
		expect(out).toContain("Install method: brew-formula");
		expect(out).toContain("Available:      1.46.0");
		expect(exitCodes).toEqual([0]);
	});

	it("passes the server's refusal through with the refusal code", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(true);
		mockSendRequest.mockResolvedValue({
			id: "1",
			ok: true,
			data: {
				install: "source",
				kind: "refused",
				runningVersion: "1.45.0",
				channel: "stable",
				version: null,
				message: "Detected source; refusing: running from a checkout",
			},
		});

		await expect(handleUpdate(args({ "dry-run": "true" }))).rejects.toThrow("__exit__");

		expect(stdout()).toContain("running from a checkout");
		expect(exitCodes).toEqual([CLI_EXIT_CODE_UPDATE_REFUSED]);
	});

	// A local plan is a worse answer than none, but a stack trace is worse than both.
	it("falls back to planning locally when the server does not answer", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(true);
		mockSendRequest.mockRejectedValue(new Error("APP_NOT_RUNNING"));
		mockBuildPlan.mockResolvedValue({
			install: "tarball",
			runningVersion: "1.45.0",
			plan: { kind: "tarball", version: "1.46.0", url: "https://example.test/x.tar.gz" },
			summary: "Detected tarball; would download …",
		});

		await expect(handleUpdate(args({ check: "true" }))).rejects.toThrow("__exit__");

		expect(stdout()).toContain("Install method: tarball");
		expect(exitCodes).toEqual([0]);
	});
});

describe("dev3 update with a running headless server", () => {
	it("DELEGATES to the server instead of swapping files behind its back", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(true);
		mockSendRequest.mockResolvedValue({
			id: "1",
			ok: true,
			data: { ok: true, restarting: true, message: "Installed 1.45.2; restarting now." },
		});

		await expect(handleUpdate(args())).rejects.toThrow("__exit__");

		// A generous timeout is part of the contract, not a detail: the server does the
		// whole stage+apply inside this one request, and the 30 s default reported a
		// successful update as a crash.
		expect(mockSendRequest).toHaveBeenCalledWith(
			"/tmp/dev3-test.sock",
			"remote.selfUpdate",
			{},
			expect.objectContaining({ timeoutMs: expect.any(Number) }),
		);
		const timeoutMs = (mockSendRequest.mock.calls[0]?.[3] as { timeoutMs: number }).timeoutMs;
		expect(timeoutMs).toBeGreaterThan(60_000);
		// Only the server can hand its port and live tunnel to the successor, so the
		// CLI must never run the update itself while one is alive.
		expect(mockRunSelfUpdate).not.toHaveBeenCalled();
		expect(stdout()).toContain("restarting now");
		expect(stdout()).toContain("public tunnel URL");
		expect(exitCodes).toEqual([0]);
	});

	it("reports the server's refusal with the refusal exit code", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(true);
		mockSendRequest.mockResolvedValue({
			id: "1",
			ok: true,
			data: { ok: false, refused: true, restarting: false, message: "This dev3 is running from source" },
		});

		await expect(handleUpdate(args())).rejects.toThrow("__exit__");

		expect(stderr()).toContain("running from source");
		expect(exitCodes).toEqual([CLI_EXIT_CODE_UPDATE_REFUSED]);
	});

	it("does not delegate to a stale record whose process is gone", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(false);
		mockRunSelfUpdate.mockResolvedValue({ ok: true, restarting: false, message: "Installed 1.45.2." });

		await expect(handleUpdate(args())).rejects.toThrow("__exit__");

		expect(mockSendRequest).not.toHaveBeenCalled();
		expect(mockRunSelfUpdate).toHaveBeenCalledWith(expect.objectContaining({ restart: false }));
	});
});

describe("dev3 update with nothing running", () => {
	it("installs in place and restarts nothing", async () => {
		mockReadState.mockReturnValue(null);
		mockRunSelfUpdate.mockResolvedValue({
			ok: true,
			restarting: false,
			message: "Installed 1.45.2. Nothing was running, so nothing had to restart.",
		});

		await expect(handleUpdate(args())).rejects.toThrow("__exit__");

		expect(mockRunSelfUpdate).toHaveBeenCalledWith(expect.objectContaining({ channel: "stable", restart: false }));
		expect(stdout()).toContain("Nothing was running");
		expect(exitCodes).toEqual([0]);
	});

	it("exits with the refusal code when the engine refuses", async () => {
		mockReadState.mockReturnValue(null);
		mockRunSelfUpdate.mockResolvedValue({
			ok: false,
			refused: true,
			restarting: false,
			message: "Self-update is not available on Windows yet",
		});

		await expect(handleUpdate(args())).rejects.toThrow("__exit__");

		expect(exitCodes).toEqual([CLI_EXIT_CODE_UPDATE_REFUSED]);
	});

	// 15 promises "nothing was changed". A download that 404s, an unwritable install
	// dir or a half-done file swap is an ordinary failure — reporting it as a refusal
	// makes any automation that skips unsupported installs swallow real breakage.
	it("exits 1 — not the refusal code — when the update was attempted and FAILED", async () => {
		mockReadState.mockReturnValue(null);
		mockRunSelfUpdate.mockResolvedValue({
			ok: false,
			restarting: false,
			message: "HTTP 404 downloading https://example.invalid/dev3-cli-linux-x64.tar.gz",
		});

		await expect(handleUpdate(args())).rejects.toThrow("__exit__");

		expect(exitCodes).toEqual([CLI_EXIT_CODE_COMMAND_FAILED]);
	});
});
