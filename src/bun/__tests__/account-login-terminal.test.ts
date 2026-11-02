import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty-server", () => ({ registerExternalPtySession: vi.fn() }));
vi.mock("../settings", () => ({ loadSettings: vi.fn(async () => ({})) }));

import type { AccountLoginState, AgentAccount, AgentAccountKind } from "../../shared/agent-accounts";
import { LoginNotReadyError, type PreparedAccountLogin } from "../agent-accounts";
import {
	ACCOUNT_LOGIN_POLL_MS,
	ACCOUNT_LOGIN_PROBE_BACKOFF_MS,
	ACCOUNT_LOGIN_SESSION_PREFIX,
	ACCOUNT_LOGIN_SUCCESS_LINGER_MS,
	ACCOUNT_LOGIN_TTL_MS,
	createAccountLoginManager,
	loginArgv,
	loginEnv,
	resolveLoginExecutable,
	type AccountLoginDeps,
	type LoginSpawnOptions,
} from "../account-login-terminal";
import type { ExternalPtySession, ExternalPtyViewer } from "../pty-server";
import { loadSettings } from "../settings";

/** Hand-cranked clock: every timer fires only when the test advances it. */
function fakeClock() {
	let now = 1_000;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => {
			seq += 1;
			timers.set(seq, { at: now + ms, fn });
			return seq;
		},
		clearTimer: (handle: unknown) => {
			timers.delete(handle as number);
		},
		async advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await flush();
			}
			now = target;
			await flush();
		},
	};
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

interface FakeProc {
	argv: string[];
	opts: LoginSpawnOptions;
	writes: string[];
	sizes: [number, number][];
	signals: (string | undefined)[];
	exit(code: number | null): void;
	closed: boolean;
}

function setup(overrides: Partial<AccountLoginDeps> = {}) {
	const clock = fakeClock();
	const procs: FakeProc[] = [];
	const identity = new Set<string>();
	const registered = new Set<string>();
	const discarded: string[] = [];
	const discardCalls: string[] = [];
	const pushes: { kind: AgentAccountKind; state: AccountLoginState | null }[] = [];
	const viewerSessions = new Map<string, ExternalPtySession>();
	let ids = 0;
	const complete = vi.fn(async (kind: AgentAccountKind, accountId: string, _ctx?: { signal: AbortSignal; stillWanted: () => boolean }): Promise<AgentAccount> => {
		if (!identity.has(accountId)) throw new LoginNotReadyError("not yet");
		registered.add(accountId);
		return { id: accountId, kind, label: "new@example.com" } as AgentAccount;
	});
	const deps: AccountLoginDeps = {
		prepare: vi.fn(async (kind: AgentAccountKind, opts: { deviceAuth: boolean }): Promise<PreparedAccountLogin> => {
			ids += 1;
			const accountId = `acc-${ids}`;
			const args = kind === "claude" ? ["/login"] : opts.deviceAuth ? ["login", "--device-auth"] : ["login"];
			return {
				accountId,
				loginCommand: `${kind} ${args.join(" ")}`,
				launch: { command: kind, args, env: { [kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: `/staged/${accountId}` }, cwd: `/staged/${accountId}` },
			};
		}),
		complete,
		hasIdentity: (_kind, accountId) => identity.has(accountId),
		addWithoutLogin: (kind, accountId) => {
			registered.add(accountId);
			return { id: accountId, kind, label: "Account 1" } as AgentAccount;
		},
		discard: (_kind, accountId) => {
			discardCalls.push(accountId);
			if (registered.has(accountId)) return false;
			discarded.push(accountId);
			return true;
		},
		touchStaged: vi.fn(),
		sweepAbandoned: vi.fn(),
		resolveExecutable: async (_kind, command) => `/usr/local/bin/${command}`,
		spawnLogin: (argv, opts) => {
			let resolveExit!: (code: number | null) => void;
			const exited = new Promise<number | null>((r) => { resolveExit = r; });
			const proc: FakeProc = {
				argv,
				opts,
				writes: [],
				sizes: [],
				signals: [],
				closed: false,
				exit: (code) => resolveExit(code),
			};
			procs.push(proc);
			return {
				terminal: {
					write: (d) => proc.writes.push(d),
					resize: (c, r) => proc.sizes.push([c, r]),
					close: () => { proc.closed = true; },
				},
				exited,
				kill: (signal) => {
					proc.signals.push(signal);
					resolveExit(null);
				},
			};
		},
		registerViewerSession: (key, session) => {
			viewerSessions.set(key, session);
			return () => viewerSessions.delete(key);
		},
		push: (state, kind) => pushes.push({ kind, state }),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		platform: "darwin",
		env: { PATH: "/usr/bin", CLAUDECODE: "1" },
		headless: false,
		...overrides,
	};
	const manager = createAccountLoginManager(deps);
	/** Open the sign-in and click "Start sign-in". */
	const startRunning = async (kind: AgentAccountKind, opts: { remoteViewer: boolean }) => manager.start(kind, opts).then((state) => (state.phase === "ready" ? manager.begin(state.loginId) : state));
	return { manager, startRunning, deps, clock, procs, identity, registered, discarded, discardCalls, pushes, viewerSessions, complete };
}

function viewer() {
	const sent: string[] = [];
	const v: ExternalPtyViewer & { sent: string[]; closed: boolean } = {
		sent,
		closed: false,
		sendText: (text) => sent.push(text),
		close: () => { v.closed = true; },
	};
	return v;
}

describe("account login manager", () => {
	let env: ReturnType<typeof setup>;
	beforeEach(() => {
		env = setup();
	});

	it("opening a sign-in spawns nothing: no process, no executable lookup, no status probe, no polling", async () => {
		const resolveExecutable = vi.spyOn(env.deps, "resolveExecutable");
		const spawnLogin = vi.spyOn(env.deps, "spawnLogin");
		for (const kind of ["claude", "codex", "omp", "pi"] as const) {
			const state = await env.manager.start(kind, { remoteViewer: false });
			expect(state).toMatchObject({ phase: "ready", sessionKey: null, manualCommand: expect.any(String) });
			env.manager.close(state.loginId);
		}
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS * 5);
		expect(resolveExecutable).not.toHaveBeenCalled();
		expect(spawnLogin).not.toHaveBeenCalled();
		expect(env.complete).not.toHaveBeenCalled();
		expect(env.procs).toHaveLength(0);
	});

	it("a ready sign-in is not polled even when an identity shows up in its dir", async () => {
		await env.manager.start("claude", { remoteViewer: false });
		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS * 5);
		expect(env.complete).not.toHaveBeenCalled();
		expect(env.manager.get("claude")?.phase).toBe("ready");
	});

	it("Start sign-in launches from ready, only once", async () => {
		const ready = await env.manager.start("claude", { remoteViewer: false });
		const state = await env.manager.begin(ready.loginId);
		expect(state).toMatchObject({ phase: "running", sessionKey: `${ACCOUNT_LOGIN_SESSION_PREFIX}${ready.loginId}` });
		expect(env.procs).toHaveLength(1);
		await expect(env.manager.begin(ready.loginId)).rejects.toThrow(/already started/);
		await expect(env.manager.begin("no-such-login")).rejects.toThrow(/already ended/);
		expect(env.procs).toHaveLength(1);
	});

	it("Start sign-in does not publish running before the viewer session exists", async () => {
		let release!: (path: string) => void;
		env = setup({ resolveExecutable: () => new Promise<string | null>((resolve) => { release = resolve; }) });
		const ready = await env.manager.start("claude", { remoteViewer: false });
		env.pushes.length = 0;
		const beginning = env.manager.begin(ready.loginId);
		await flush();
		expect(env.pushes.filter((p) => p.state?.phase === "running")).toEqual([]);
		release("/usr/local/bin/claude");
		const state = await beginning;
		expect(env.viewerSessions.has(state.sessionKey!)).toBe(true);
		expect(env.pushes.filter((p) => p.state?.phase === "running")).toHaveLength(1);
	});

	it("while the launch is pending the sign-in still reads as ready with no session key, and a second begin is refused", async () => {
		let release!: (path: string) => void;
		env = setup({ resolveExecutable: () => new Promise<string | null>((resolve) => { release = resolve; }) });
		const ready = await env.manager.start("claude", { remoteViewer: false });
		const beginning = env.manager.begin(ready.loginId);
		await flush();
		expect(env.manager.get("claude")).toMatchObject({ phase: "ready", sessionKey: null });
		expect(await env.manager.start("claude", { remoteViewer: false })).toMatchObject({ phase: "ready", sessionKey: null });
		await expect(env.manager.begin(ready.loginId)).rejects.toThrow(/already started/);
		release("/usr/local/bin/claude");
		expect(await beginning).toMatchObject({ phase: "running", sessionKey: `${ACCOUNT_LOGIN_SESSION_PREFIX}${ready.loginId}` });
		expect(env.procs).toHaveLength(1);
	});

	it("begin on a finished sign-in says it has ended", async () => {
		env = setup({ resolveExecutable: async () => { throw new Error("Custom executable for agent \"Claude Code\" not found or not executable: /gone"); } });
		const failed = await env.startRunning("claude", { remoteViewer: false });
		expect(failed.phase).toBe("failed");
		await expect(env.manager.begin(failed.loginId)).rejects.toThrow(/already ended/);
	});

	it("Start sign-in refreshes the staged dir's abandoned clock", async () => {
		const ready = await env.manager.start("claude", { remoteViewer: false });
		await env.manager.begin(ready.loginId);
		expect(env.deps.touchStaged).toHaveBeenCalledWith("claude", "acc-1");
	});

	it("Start sign-in fails as ended when the sign-in was cancelled during the launch", async () => {
		let release!: (path: string) => void;
		env = setup({ resolveExecutable: () => new Promise<string | null>((resolve) => { release = resolve; }) });
		const ready = await env.manager.start("claude", { remoteViewer: false });
		const beginning = env.manager.begin(ready.loginId);
		const settled = beginning.catch((e) => e);
		await flush();
		env.manager.close(ready.loginId);
		release("/usr/local/bin/claude");
		expect(String(await settled)).toContain("already ended");
		expect(env.procs).toHaveLength(0);
	});

	it("a ready sign-in expires after the TTL and releases its staged dir", async () => {
		await env.manager.start("claude", { remoteViewer: false });
		await env.clock.advance(ACCOUNT_LOGIN_TTL_MS);
		expect(env.manager.get("claude")?.phase).toBe("expired");
		expect(env.discarded).toEqual(["acc-1"]);
	});

	it("cancelling a ready sign-in discards its staged dir", async () => {
		const ready = await env.manager.start("codex", { remoteViewer: false });
		env.manager.close(ready.loginId);
		expect(env.manager.get("codex")).toBeNull();
		expect(env.discarded).toEqual(["acc-1"]);
	});

	it("a Claude sign-in can be added without signing in straight from ready", async () => {
		const ready = await env.manager.start("claude", { remoteViewer: false });
		const state = env.manager.addWithoutSignIn(ready.loginId);
		expect(state).toMatchObject({ phase: "added-unsigned", account: { id: "acc-1" } });
		expect(env.procs).toHaveLength(0);
	});

	it("spawns the provider's login scoped to the staged dir and serves it as a PTY session", async () => {
		const state = await env.startRunning("claude", { remoteViewer: false });

		expect(state.phase).toBe("running");
		expect(state.sessionKey).toBe(`${ACCOUNT_LOGIN_SESSION_PREFIX}${state.loginId}`);
		expect(env.procs).toHaveLength(1);
		expect(env.procs[0].argv).toEqual(["/usr/local/bin/claude", "/login"]);
		expect(env.procs[0].opts.env.CLAUDE_CONFIG_DIR).toBe("/staged/acc-1");
		expect(env.procs[0].opts.env.CLAUDECODE).toBeUndefined();
		expect(env.viewerSessions.has(state.sessionKey!)).toBe(true);
	});

	it("process exit is not success: it reports `exited` and keeps watching the staged dir", async () => {
		await env.startRunning("codex", { remoteViewer: false });
		env.procs[0].exit(0);
		await flush();

		expect(env.manager.get("codex")?.phase).toBe("exited");
		expect(env.manager.get("codex")?.exitCode).toBe(0);
		expect(env.registered.size).toBe(0);

		// The user finishes with the manual command in their own terminal.
		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.manager.get("codex")?.phase).toBe("succeeded");
		expect(env.registered.has("acc-1")).toBe(true);
	});

	it("succeeds only through the existing verification, then stops the lingering REPL", async () => {
		await env.startRunning("claude", { remoteViewer: false });
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS * 3);
		expect(env.complete).not.toHaveBeenCalled();

		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		const state = env.manager.get("claude")!;
		expect(state.phase).toBe("succeeded");
		expect(state.account?.label).toBe("new@example.com");
		expect(env.procs[0].signals).toEqual([]);

		await env.clock.advance(ACCOUNT_LOGIN_SUCCESS_LINGER_MS);
		expect(env.procs[0].signals).toEqual(["SIGTERM"]);

		// Done: the verified account's dir is never even offered for deletion.
		env.manager.close(state.loginId);
		expect(env.discardCalls).toEqual([]);
		expect(env.pushes[env.pushes.length - 1]).toEqual({ kind: "claude", state: null });
	});

	it("an identity whose credentials are not written yet keeps waiting instead of failing", async () => {
		env.complete.mockRejectedValueOnce(new LoginNotReadyError("credentials missing"));
		await env.startRunning("claude", { remoteViewer: false });
		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.manager.get("claude")?.phase).toBe("running");

		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.manager.get("claude")?.phase).toBe("succeeded");
	});

	it("a real verification error (duplicate) fails, stops the process, and Close discards the staged dir", async () => {
		env.complete.mockRejectedValueOnce(new Error('This account is already added ("work")'));
		const state = await env.startRunning("claude", { remoteViewer: false });
		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);

		expect(env.manager.get("claude")).toMatchObject({ phase: "failed", error: 'This account is already added ("work")' });
		expect(env.procs[0].signals).toEqual(["SIGTERM"]);
		env.manager.close(state.loginId);
		expect(env.discarded).toEqual(["acc-1"]);
	});

	it("cancel stops only its own process and releases only its unregistered dir", async () => {
		const claude = await env.startRunning("claude", { remoteViewer: false });
		await env.startRunning("codex", { remoteViewer: false });
		const v = viewer();
		env.viewerSessions.get(claude.sessionKey!)!.attach(v);

		env.manager.close(claude.loginId);

		expect(env.procs[0].signals).toEqual(["SIGTERM"]);
		expect(env.procs[1].signals).toEqual([]);
		expect(env.discarded).toEqual(["acc-1"]);
		expect(v.closed).toBe(true);
		expect(env.viewerSessions.has(claude.sessionKey!)).toBe(false);
		expect(env.manager.get("codex")?.phase).toBe("running");
	});

	it("a new sign-in first sweeps abandoned leftovers for its CLI, a joined one does not", async () => {
		await env.startRunning("claude", { remoteViewer: false });
		await env.startRunning("claude", { remoteViewer: false });
		expect(env.deps.sweepAbandoned).toHaveBeenCalledTimes(1);
		expect(env.deps.sweepAbandoned).toHaveBeenCalledWith("claude");
	});

	it("a second Add for the same CLI joins the running sign-in instead of racing it", async () => {
		const first = await env.startRunning("codex", { remoteViewer: false });
		const second = await env.startRunning("codex", { remoteViewer: true });
		expect(second.loginId).toBe(first.loginId);
		expect(env.procs).toHaveLength(1);
	});

	it("a remote viewer or headless host gets Codex device auth", async () => {
		const remote = await env.startRunning("codex", { remoteViewer: true });
		expect(remote.deviceAuth).toBe(true);
		expect(env.procs[0].argv).toEqual(["/usr/local/bin/codex", "login", "--device-auth"]);

		const headless = setup({ headless: true });
		expect((await headless.manager.start("codex", { remoteViewer: false })).deviceAuth).toBe(true);
		expect((await headless.manager.start("claude", { remoteViewer: false })).deviceAuth).toBe(false);
	});

	it("a missing CLI starts no process but still watches, so the manual fallback lands", async () => {
		env = setup({ resolveExecutable: async () => null });
		const state = await env.startRunning("claude", { remoteViewer: false });
		expect(state).toMatchObject({ phase: "missing-executable", sessionKey: null, manualCommand: "claude /login" });
		expect(env.procs).toHaveLength(0);

		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.manager.get("claude")?.phase).toBe("succeeded");
	});

	it("add without signing in registers the staged dir, stops the terminal and keeps the login command", async () => {
		const started = await env.startRunning("claude", { remoteViewer: false });
		const state = env.manager.addWithoutSignIn(started.loginId);
		expect(state).toMatchObject({ phase: "added-unsigned", sessionKey: null, manualCommand: "claude /login", account: { id: "acc-1", label: "Account 1" } });
		expect(env.procs[0].signals).toEqual(["SIGTERM"]);
		expect(env.manager.get("claude")?.phase).toBe("added-unsigned");
		expect(env.pushes[env.pushes.length - 1]).toMatchObject({ kind: "claude", state: { phase: "added-unsigned" } });
		// Nothing watches or expires it any more, and closing it keeps the account.
		await env.clock.advance(ACCOUNT_LOGIN_TTL_MS);
		expect(env.manager.get("claude")?.phase).toBe("added-unsigned");
		env.manager.close(started.loginId);
		expect(env.discarded).toEqual([]);
	});

	it("add without signing in works from exited and missing-executable too", async () => {
		env = setup({ resolveExecutable: async () => null });
		const started = await env.startRunning("claude", { remoteViewer: false });
		expect(started.phase).toBe("missing-executable");
		expect(env.manager.addWithoutSignIn(started.loginId).phase).toBe("added-unsigned");
	});

	it("add without signing in refuses a non-Claude sign-in, an unknown login and a finished one", async () => {
		const codex = await env.startRunning("codex", { remoteViewer: false });
		expect(() => env.manager.addWithoutSignIn(codex.loginId)).toThrow(/Only a Claude sign-in/);
		expect(() => env.manager.addWithoutSignIn("no-such-login")).toThrow(/already ended/);
		const claude = await env.startRunning("claude", { remoteViewer: false });
		env.identity.add("acc-2");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.manager.get("claude")?.phase).toBe("succeeded");
		expect(() => env.manager.addWithoutSignIn(claude.loginId)).toThrow(/no longer/);
	});

	it("add without signing in refuses while verifying and when a sign-in was already found", async () => {
		env.complete.mockImplementation(() => new Promise<AgentAccount>(() => {}));
		const started = await env.startRunning("claude", { remoteViewer: false });
		env.identity.add("acc-1");
		expect(() => env.manager.addWithoutSignIn(started.loginId)).toThrow(/wait for dev3 to confirm/);
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.manager.get("claude")?.phase).toBe("verifying");
		expect(() => env.manager.addWithoutSignIn(started.loginId)).toThrow(/no longer/);
		expect(env.registered.has("acc-1")).toBe(false);
	});

	it("an add without signing in during the executable lookup is not overwritten by the launch", async () => {
		let release!: (path: string) => void;
		env = setup({ resolveExecutable: () => new Promise<string | null>((resolve) => { release = resolve; }) });
		const starting = env.startRunning("claude", { remoteViewer: false });
		await flush();
		env.manager.addWithoutSignIn(env.manager.get("claude")!.loginId);
		release("/usr/local/bin/claude");
		await starting;
		expect(env.manager.get("claude")?.phase).toBe("added-unsigned");
		expect(env.procs).toHaveLength(0);
	});

	it("a broken custom executable fails the sign-in with its path and releases the staged dir", async () => {
		env = setup({ resolveExecutable: async () => { throw new Error("Custom executable for agent \"Claude Code\" not found or not executable: /gone"); } });
		const state = await env.startRunning("claude", { remoteViewer: false });
		expect(state).toMatchObject({ phase: "failed", sessionKey: null, error: expect.stringContaining("/gone") });
		expect(env.procs).toHaveLength(0);
		expect(env.discarded).toEqual(["acc-1"]);
	});

	it("expires after the TTL: stops the process and discards the staged dir", async () => {
		await env.startRunning("claude", { remoteViewer: false });
		await env.clock.advance(ACCOUNT_LOGIN_TTL_MS);
		expect(env.manager.get("claude")?.phase).toBe("expired");
		expect(env.procs[0].signals).toEqual(["SIGTERM"]);
		expect(env.discarded).toEqual(["acc-1"]);
	});

	it("restart replaces the attempt with a fresh staged dir", async () => {
		const first = await env.startRunning("claude", { remoteViewer: false });
		env.procs[0].exit(1);
		await flush();
		const next = await env.manager.restart(first.loginId, { remoteViewer: false });
		expect(next.loginId).not.toBe(first.loginId);
		expect(env.discarded).toEqual(["acc-1"]);
		expect(env.procs[1].opts.env.CLAUDE_CONFIG_DIR).toBe("/staged/acc-2");
	});

	it("a viewer that (re)opens gets the output so far, and its keys and size reach the PTY", async () => {
		const state = await env.startRunning("claude", { remoteViewer: false });
		env.procs[0].opts.onData("Select login method:\r\n");
		const late = viewer();
		const session = env.viewerSessions.get(state.sessionKey!)!;
		session.attach(late);
		expect(late.sent.join("")).toContain("Select login method:");

		session.input(late, "\r");
		session.resize(late, 120, 40);
		expect(env.procs[0].writes).toEqual(["\r"]);
		expect(env.procs[0].sizes).toEqual([[120, 40]]);
	});

	it("an unconfirmed status backs off instead of probing every poll, and says why", async () => {
		env.complete.mockImplementation(async () => {
			throw new LoginNotReadyError("not confirmed", "status-unavailable");
		});
		await env.startRunning("claude", { remoteViewer: false });
		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.complete).toHaveBeenCalledTimes(1);
		expect(env.manager.get("claude")).toMatchObject({ phase: "running", pending: "status-unavailable" });

		await env.clock.advance(ACCOUNT_LOGIN_PROBE_BACKOFF_MS - ACCOUNT_LOGIN_POLL_MS);
		expect(env.complete).toHaveBeenCalledTimes(1);
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS * 2);
		expect(env.complete).toHaveBeenCalledTimes(2);
	});

	it("a cancel during verification aborts the probe and its late result is discarded", async () => {
		let finish!: (account: AgentAccount) => void;
		let seenSignal: AbortSignal | null = null;
		let stillWanted: (() => boolean) | null = null;
		env.complete.mockImplementation((_kind: AgentAccountKind, accountId: string, ctx?: { signal: AbortSignal; stillWanted: () => boolean }) => {
			seenSignal = ctx!.signal;
			stillWanted = ctx!.stillWanted;
			return new Promise<AgentAccount>((resolve) => { finish = resolve; void accountId; });
		});
		const state = await env.startRunning("claude", { remoteViewer: false });
		env.identity.add("acc-1");
		await env.clock.advance(ACCOUNT_LOGIN_POLL_MS);
		expect(env.manager.get("claude")?.phase).toBe("verifying");

		env.manager.close(state.loginId);
		expect(seenSignal!.aborted).toBe(true);
		expect(stillWanted!()).toBe(false);
		finish({ id: "acc-1", kind: "claude", label: "late" } as AgentAccount);
		await flush();
		expect(env.manager.get("claude")).toBeNull();
		expect(env.pushes.some((p) => p.state?.phase === "succeeded")).toBe(false);
	});

	it("pushes carry phase only — never terminal output", async () => {
		await env.startRunning("claude", { remoteViewer: false });
		env.procs[0].opts.onData("https://example.com/oauth?code=SECRET\r\n");
		env.procs[0].exit(1);
		await flush();
		expect(JSON.stringify(env.pushes)).not.toContain("SECRET");
	});
});

describe("loginArgv", () => {
	it("execs directly on POSIX", () => {
		expect(loginArgv("/opt/bin/claude", ["/login"], "linux", {})).toEqual(["/opt/bin/claude", "/login"]);
	});

	it("routes a Windows npm .cmd shim through cmd.exe and a .ps1 through PowerShell", () => {
		expect(loginArgv("C:\\npm\\codex.cmd", ["login"], "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual([
			"C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "C:\\npm\\codex.cmd", "login",
		]);
		expect(loginArgv("C:\\npm\\codex.ps1", ["login"], "win32", {})[0]).toBe("powershell.exe");
		expect(loginArgv("C:\\bin\\claude.exe", ["/login"], "win32", {})).toEqual(["C:\\bin\\claude.exe", "/login"]);
	});
});

describe("loginEnv", () => {
	it("lets the scoped dir win over an inherited one", () => {
		const env = loginEnv({ CLAUDE_CONFIG_DIR: "/home/me/.claude", HOME: "/home/me" }, { CLAUDE_CONFIG_DIR: "/staged/x" }, "claude");
		expect(env.CLAUDE_CONFIG_DIR).toBe("/staged/x");
		expect(env.HOME).toBe("/home/me");
		expect(env.TERM).toBe("xterm-256color");
	});

	it("unsets env that would authenticate the CLI, even after spawn merges process.env back in", () => {
		const base = { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "t", OPENAI_API_KEY: "o", PATH: "/bin" };
		// What src/bun/spawn.ts hands Bun: process.env underneath, our env on top.
		const merged = (env: Record<string, string | undefined>) => ({ ...base, ...env });
		const claude = merged(loginEnv(base, {}, "claude"));
		expect(claude.ANTHROPIC_API_KEY).toBeUndefined();
		expect(claude.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
		expect(claude.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(claude.PATH).toBe("/bin");
		expect(merged(loginEnv(base, {}, "codex")).OPENAI_API_KEY).toBeUndefined();
	});

	it("leaves the user's own provider keys to omp, scoped only by its agent dir", () => {
		const env = loginEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "k", PI_CODING_AGENT_DIR: "/home/me/.omp/agent" }, { PI_CODING_AGENT_DIR: "/staged/o" }, "omp");
		expect(env.PI_CODING_AGENT_DIR).toBe("/staged/o");
		expect(env.OPENAI_API_KEY).toBe("o");
		expect(env.ANTHROPIC_API_KEY).toBe("k");
	});
});

describe("resolveLoginExecutable with a custom executable", () => {
	it("throws for a broken custom path instead of finding the CLI on PATH", async () => {
		vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-claude": "/definitely/not/here/claude" } } as never);
		await expect(resolveLoginExecutable("claude", "node")).rejects.toThrow("/definitely/not/here/claude");
	});

	it("uses a working custom path", async () => {
		vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-claude": process.execPath } } as never);
		expect(await resolveLoginExecutable("claude", "claude")).toBe(process.execPath);
	});
});
