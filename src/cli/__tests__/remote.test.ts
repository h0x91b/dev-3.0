import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleRemote, printAccessForState } from "../commands/remote";
import type { ParsedArgs } from "../args";

/**
 * On the happy path `handleRemote` boots the headless server in-process via
 * `await import("../../bun/headless-entry")`. We can't let the real server boot
 * in a unit test, so we mock that module to an empty no-op — the dynamic import
 * then resolves instantly and `handleRemote` returns after applying its env
 * vars. `process.exit` is spied on so exitUsage() raises synchronously instead
 * of tearing the test runner down.
 */
vi.mock("../../bun/headless-entry", () => ({}));

// `dev3 remote --detach` spawns a detached background copy of itself. Stub spawn
// so the detach tests can drive the child's lifecycle without a real process.
vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn(), pid: 1234 })),
}));

// status/url/stop read the lifecycle state file and talk to the running server
// over its CLI socket. Mock both boundaries so the dispatch + formatting logic
// is exercised without a real server or fs.
vi.mock("../../bun/remote-state", () => ({
	REMOTE_DIR: "/tmp/dev3-remote-unit-test",
	REMOTE_LOG_FILE: "/tmp/dev3-remote-unit-test/remote.log",
	readRemoteState: vi.fn(),
	isProcessAlive: vi.fn(),
	clearRemoteState: vi.fn(),
	acquireStartLock: vi.fn(() => 7),
	releaseStartLock: vi.fn(),
}));
vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));
vi.mock("qrcode", () => ({
	default: { toString: vi.fn(async () => "QR-ASCII\n") },
}));

import { readRemoteState, isProcessAlive, clearRemoteState, acquireStartLock, releaseStartLock } from "../../bun/remote-state";
import { sendRequest } from "../socket-client";
import type { RemoteServerState } from "../../shared/types";

const mockReadState = vi.mocked(readRemoteState);
const mockIsAlive = vi.mocked(isProcessAlive);
const mockClearState = vi.mocked(clearRemoteState);
const mockAcquireLock = vi.mocked(acquireStartLock);
const mockReleaseLock = vi.mocked(releaseStartLock);
const mockSendRequest = vi.mocked(sendRequest);

function liveState(overrides: Partial<RemoteServerState> = {}): RemoteServerState {
	return {
		pid: 4242,
		port: 41234,
		socketPath: "/tmp/dev3-test.sock",
		tunnelRequested: true,
		staticCode: null,
		logFile: "/tmp/dev3-remote-unit-test/remote.log",
		startedAt: new Date(Date.now() - 65_000).toISOString(),
		version: "1.27.0",
		...overrides,
	};
}

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
		throw new Error("__exit__");
	}) as never);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	// clearAllMocks (afterEach) clears call history but NOT implementations, so
	// reset the lifecycle/socket mocks here to stop mockReturnValue bleed-through.
	mockReadState.mockReset();
	mockIsAlive.mockReset();
	mockClearState.mockReset();
	mockSendRequest.mockReset();
	mockAcquireLock.mockReset();
	mockAcquireLock.mockReturnValue(7); // default: lock granted
	mockReleaseLock.mockReset();
});

afterEach(() => {
	exitSpy.mockRestore();
	stderrSpy.mockRestore();
	stdoutSpy.mockRestore();
	vi.clearAllMocks();
});

describe("dev3 remote --port validation", () => {
	it("rejects --port without a value", async () => {
		await expect(handleRemote(undefined, args({ port: "true" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port requires a value");
	});

	it("rejects non-numeric port", async () => {
		await expect(handleRemote(undefined, args({ port: "abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("rejects port below range", async () => {
		await expect(handleRemote(undefined, args({ port: "0" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("rejects port above 65535", async () => {
		await expect(handleRemote(undefined, args({ port: "70000" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("rejects port with trailing garbage", async () => {
		// Number.parseInt("3000abc", 10) === 3000; the trim/equality check must
		// reject this so we don't silently accept "3000abc" as 3000.
		await expect(handleRemote(undefined, args({ port: "3000abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("accepts a valid port and applies it to process.env (DEV3_REMOTE_PORT + DEV3_HEADLESS)", async () => {
		// Single in-process path now: a valid port is applied to process.env, then
		// the (mocked) headless-entry import resolves and handleRemote returns.
		const ENV_KEYS = [
			"DEV3_REMOTE_PORT",
			"DEV3_HEADLESS",
			"DEV3_REMOTE_NO_TUNNEL",
			"DEV3_VIEWS_DIR",
			"DEV3_REMOTE_STATIC_CODE",
			"DEV3_REMOTE_EXPOSE_PORTS",
		] as const;
		const saved: Record<string, string | undefined> = {};
		for (const k of ENV_KEYS) saved[k] = process.env[k];

		try {
			await handleRemote(undefined, args({ port: "3000" }));
			expect(process.env.DEV3_REMOTE_PORT).toBe("3000");
			expect(process.env.DEV3_HEADLESS).toBe("1");
		} finally {
			for (const k of ENV_KEYS) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	});

	it("rejects unknown flags", async () => {
		await expect(handleRemote(undefined, args({ bogus: "true" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("Unknown option: --bogus");
	});
});

describe("dev3 remote --expose-ports validation", () => {
	it("rejects --expose-ports without a value", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "true" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--expose-ports requires a value");
	});

	it("rejects non-numeric port in the list", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "3000,abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("invalid port");
	});

	it("rejects out-of-range port", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "70000" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("invalid port");
	});

	it("rejects port with trailing garbage", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "3000abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("invalid port");
	});
});

const stdoutText = () => stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
const stderrText = () => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

describe("dev3 remote status", () => {
	it("reports when no server is running", async () => {
		mockReadState.mockReturnValue(null);
		await expect(handleRemote("status", args())).rejects.toThrow("__exit__");
		expect(stdoutText()).toContain("No dev3 remote server is running.");
	});

	it("clears a stale record when the recorded pid is dead", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(false);
		await expect(handleRemote("status", args())).rejects.toThrow("__exit__");
		expect(mockClearState).toHaveBeenCalledOnce();
		expect(stdoutText()).toContain("cleared a stale record");
	});

	it("prints pid/port/uptime and a fresh URL for a live server", async () => {
		mockReadState.mockReturnValue(liveState({ pid: 4242, port: 41234 }));
		mockIsAlive.mockReturnValue(true);
		mockSendRequest.mockResolvedValue({
			id: "x", ok: true,
			data: { url: "https://abc.trycloudflare.com/?token=t", tunnelUrl: "https://abc.trycloudflare.com", port: 41234, staticCode: null },
		});
		await expect(handleRemote("status", args())).rejects.toThrow("__exit__");
		const out = stdoutText();
		expect(out).toContain("running");
		expect(out).toContain("4242");
		expect(out).toContain("41234");
		expect(out).toContain("https://abc.trycloudflare.com/?token=t");
	});
});

describe("dev3 remote url", () => {
	it("errors with APP_NOT_RUNNING exit when nothing is running", async () => {
		mockReadState.mockReturnValue(null);
		const codes: number[] = [];
		exitSpy.mockImplementation(((code?: number) => { codes.push(code ?? 0); throw new Error("__exit__"); }) as never);
		await expect(handleRemote("url", args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("No dev3 remote server is running.");
		expect(codes).toContain(2); // CLI_EXIT_CODE_APP_NOT_RUNNING
	});

	it("prints a QR + URL from the running server", async () => {
		mockReadState.mockReturnValue(liveState());
		mockIsAlive.mockReturnValue(true);
		mockSendRequest.mockResolvedValue({
			id: "x", ok: true,
			data: { url: "http://192.168.1.5:41234/?token=abc", tunnelUrl: null, port: 41234, staticCode: null },
		});
		await expect(handleRemote("url", args())).rejects.toThrow("__exit__");
		const out = stdoutText();
		expect(out).toContain("QR-ASCII");
		expect(out).toContain("http://192.168.1.5:41234/?token=abc");
	});
});

describe("dev3 remote stop", () => {
	it("reports when no server is running", async () => {
		mockReadState.mockReturnValue(null);
		await expect(handleRemote("stop", args())).rejects.toThrow("__exit__");
		expect(stdoutText()).toContain("No dev3 remote server is running.");
	});

	it("SIGTERMs a live server and reports it stopped", async () => {
		mockReadState.mockReturnValue(liveState({ pid: 4242 }));
		// alive at the guard check, dead on the first poll iteration
		mockIsAlive.mockReturnValueOnce(true).mockReturnValue(false);
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
		try {
			await expect(handleRemote("stop", args())).rejects.toThrow("__exit__");
			expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
			expect(mockClearState).toHaveBeenCalled();
			expect(stdoutText()).toContain("Stopped dev3 remote server (pid 4242)");
		} finally {
			killSpy.mockRestore();
		}
	});
});

describe("dev3 remote --detach (lifecycle)", () => {
	// A controllable fake ChildProcess. `fireError` makes child.on("error", …) fire
	// synchronously on registration, simulating an un-spawnable binary.
	function fakeChild(opts: { pid: number; fireError?: Error }) {
		return {
			pid: opts.pid,
			unref: vi.fn(),
			on(event: string, cb: (arg: unknown) => void) {
				if (event === "error" && opts.fireError) cb(opts.fireError);
				return this;
			},
		};
	}

	// F4: a second --detach while another launch holds the start lock is refused
	// (rather than spawning a second server that orphans the first). This bails
	// before spawn, so it's runtime-independent.
	it("refuses to start when the start lock is already held (F4)", async () => {
		mockAcquireLock.mockReturnValue(null);
		await expect(handleRemote(undefined, args({ detach: "true" }))).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("already starting up");
	});

	// F2: spawn failing with ENOENT/EACCES must surface a friendly message via the
	// "error" event, not crash the CLI with an unhandled-error stack trace. In the
	// single-binary model startDetached spawns process.execPath directly (no
	// binary-locate gate), so the spawn site is reached unconditionally.
	it("surfaces a spawn error cleanly instead of an uncaught crash (F2)", async () => {
		const { spawn } = await import("node:child_process");
		mockReadState.mockReturnValue(null); // no prior server
		vi.mocked(spawn).mockReturnValue(fakeChild({ pid: 5151, fireError: new Error("spawn EACCES") }) as never);
		await expect(handleRemote(undefined, args({ detach: "true" }))).rejects.toThrow("__exit__");
		const out = stderrText();
		expect(out).toContain("exited during startup");
		expect(out).toContain("spawn EACCES");
		expect(mockReleaseLock).toHaveBeenCalled(); // lock released, not leaked
	});

	// F6: printAccessForState must honor notRunningIsFatal. The fatal path (used by
	// `url`) clears state + exits; the non-fatal path (used by --detach, where the
	// server is provably alive) rethrows WITHOUT clearing — clearing there would
	// orphan a live server whose socket simply hasn't come up yet.
	it("printAccessForState rethrows (no state clear) when non-fatal (F6)", async () => {
		mockSendRequest.mockRejectedValue(new Error("APP_NOT_RUNNING"));
		await expect(
			printAccessForState("/tmp/x.sock", { header: "h", withQr: false, notRunningIsFatal: false }),
		).rejects.toThrow("APP_NOT_RUNNING");
		expect(mockClearState).not.toHaveBeenCalled();
	});

	it("printAccessForState clears state + exits fatally when fatal (F6 control)", async () => {
		mockSendRequest.mockRejectedValue(new Error("APP_NOT_RUNNING"));
		const codes: number[] = [];
		exitSpy.mockImplementation(((code?: number) => { codes.push(code ?? 0); throw new Error("__exit__"); }) as never);
		await expect(
			printAccessForState("/tmp/x.sock", { header: "h", withQr: false, notRunningIsFatal: true }),
		).rejects.toThrow("__exit__");
		expect(mockClearState).toHaveBeenCalled();
		expect(codes).toContain(2); // CLI_EXIT_CODE_APP_NOT_RUNNING
	});
});

describe("dev3 remote unknown subcommand", () => {
	it("rejects an unknown subcommand", async () => {
		await expect(handleRemote("bogus", args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("Unknown subcommand: remote bogus");
	});
});

describe("dev3 remote service subcommands (dispatch)", () => {
	// The test host is macOS; both service subcommands are Linux-only, so they
	// exit early with that message — enough to prove the dispatch wiring.
	it("routes install-service", async () => {
		if (process.platform === "linux") return; // would touch real systemd — skip on Linux CI
		await expect(handleRemote("install-service", args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("Linux-only");
	});

	it("routes uninstall-service", async () => {
		if (process.platform === "linux") return;
		await expect(handleRemote("uninstall-service", args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("Linux-only");
	});
});
