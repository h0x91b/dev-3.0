/**
 * In-app sign-in for managed Claude Code / Codex accounts.
 *
 * The provider's own login command runs in a PTY on the backend host — never in
 * the viewing browser — scoped to a staged account dir by env alone. Viewers see
 * it through the PTY WebSocket (`registerExternalPtySession`), so desktop and
 * remote mode share one path, and no tmux is involved (Windows has none).
 *
 * Success is decided by the existing verification (`complete*Login`) against the
 * staged dir, which this module polls; the process exiting proves nothing. The
 * watch keeps running after an exit and when the CLI is missing, so a login the
 * user finishes in their own terminal with the manual command lands the same way.
 *
 * Ownership: the only process stopped is the one this module spawned, and the
 * only dir deleted is the staged one, through `discardStagedLogin`, which refuses
 * an id that became a saved account.
 */

import { extname } from "node:path";
import type { AccountLoginPhase, AccountLoginState, AgentAccount, AgentAccountKind } from "../shared/agent-accounts";
import { DEFAULT_AGENTS } from "../shared/types";
import * as accounts from "./agent-accounts";
import type { PreparedAccountLogin } from "./agent-accounts";
import { agentBinaryPathOverride, isExecutableFile } from "./executable";
import { createLogger } from "./logger";
import { registerExternalPtySession, type ExternalPtyViewer } from "./pty-server";
import { loadSettings } from "./settings";
import { spawn } from "./spawn";

const log = createLogger("account-login");

export const ACCOUNT_LOGIN_SESSION_PREFIX = "account-login-";
/** Longer than any provider's own code/device window, so theirs expires first and says why. */
export const ACCOUNT_LOGIN_TTL_MS = 20 * 60_000;
export const ACCOUNT_LOGIN_POLL_MS = 1_000;
/** Lets the success line render in the terminal before the REPL is stopped. */
export const ACCOUNT_LOGIN_SUCCESS_LINGER_MS = 1_500;
/** After a status probe that did not confirm the login, wait this long before the next one. */
export const ACCOUNT_LOGIN_PROBE_BACKOFF_MS = 5_000;
/** A status probe that has not answered by then counts as unavailable. */
export const ACCOUNT_LOGIN_PROBE_TIMEOUT_MS = 10_000;
/** Replayed to a viewer that (re)opens mid-login; output lives in memory only. */
export const ACCOUNT_LOGIN_REPLAY_CHARS = 64 * 1024;
const KILL_GRACE_MS = 2_000;

const ACTIVE_PHASES: ReadonlySet<AccountLoginPhase> = new Set(["running", "verifying", "exited", "missing-executable"]);
const WATCHED_PHASES: ReadonlySet<AccountLoginPhase> = new Set(["running", "exited", "missing-executable"]);

export interface LoginTerminal {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	close(): void;
}

export interface LoginProcess {
	terminal: LoginTerminal;
	exited: Promise<number | null>;
	kill(signal?: NodeJS.Signals): void;
}

export interface LoginSpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData(data: string): void;
}

export interface AccountLoginDeps {
	prepare(kind: AgentAccountKind, opts: { deviceAuth: boolean }): Promise<PreparedAccountLogin>;
	complete(kind: AgentAccountKind, accountId: string, ctx: { signal: AbortSignal; stillWanted: () => boolean }): Promise<AgentAccount>;
	hasIdentity(kind: AgentAccountKind, accountId: string): boolean;
	discard(kind: AgentAccountKind, accountId: string): boolean;
	/** Leftovers of sign-ins a killed app never closed; see `sweepAbandonedStagedLogins`. */
	sweepAbandoned(kind: AgentAccountKind): void;
	resolveExecutable(kind: AgentAccountKind, command: string): Promise<string | null>;
	spawnLogin(argv: string[], opts: LoginSpawnOptions): LoginProcess;
	registerViewerSession(key: string, session: import("./pty-server").ExternalPtySession): () => void;
	push(state: AccountLoginState | null, kind: AgentAccountKind): void;
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	headless: boolean;
}

interface LoginRecord {
	state: AccountLoginState;
	accountId: string;
	proc: LoginProcess | null;
	viewers: Set<ExternalPtyViewer>;
	replay: string;
	unregister: (() => void) | null;
	pollTimer: unknown;
	expiryTimer: unknown;
	lingerTimer: unknown;
	completing: boolean;
	/** Earliest time the next verification may run (probe backoff). */
	nextVerifyAt: number;
	/** Aborts an in-flight status probe on cancel, TTL or shutdown. */
	abort: AbortController;
}

/**
 * The argv that runs `command` with `args` on this platform. POSIX execs it
 * directly; on Windows an npm-installed CLI is a `.cmd`/`.ps1` launcher that
 * CreateProcess cannot run on its own, so it goes through its interpreter.
 */
export function loginArgv(
	resolved: string,
	args: string[],
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>,
): string[] {
	if (platform !== "win32") return [resolved, ...args];
	const ext = extname(resolved).toLowerCase();
	if (ext === ".cmd" || ext === ".bat") {
		return [env.ComSpec || env.COMSPEC || "cmd.exe", "/d", "/s", "/c", resolved, ...args];
	}
	if (ext === ".ps1") {
		return ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args];
	}
	return [resolved, ...args];
}

/** The process env plus the login's own scope. Env that would authenticate the CLI
 *  without this login (an API key, a cloud provider) is unset, as is a nesting marker.
 *  Unset means an explicit `undefined`: our `spawn` merges `process.env` underneath,
 *  so a merely deleted key would come back (seen in QA). Bun drops `undefined` values. */
export function loginEnv(
	base: Record<string, string | undefined>,
	scoped: Record<string, string>,
	kind: AgentAccountKind,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value;
	}
	env.CLAUDECODE = undefined;
	for (const key of kind === "claude" ? accounts.CLAUDE_ENV_AUTH_KEYS : accounts.CODEX_ENV_AUTH_KEYS) env[key] = undefined;
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	return { ...env, ...scoped };
}

function installUrl(kind: AgentAccountKind): string | null {
	return DEFAULT_AGENTS.find((agent) => agent.id === `builtin-${kind}`)?.installUrl ?? null;
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

export function createAccountLoginManager(deps: AccountLoginDeps) {
	const byKind = new Map<AgentAccountKind, LoginRecord>();

	function publish(record: LoginRecord): void {
		if (byKind.get(record.state.kind) !== record) return;
		deps.push({ ...record.state }, record.state.kind);
	}

	function setPhase(record: LoginRecord, phase: AccountLoginPhase, patch: Partial<AccountLoginState> = {}): void {
		record.state = { ...record.state, ...patch, phase };
		log.info("Account login phase", { kind: record.state.kind, loginId: shortId(record.state.loginId), phase, exitCode: record.state.exitCode });
		publish(record);
	}

	function broadcast(record: LoginRecord, text: string): void {
		record.replay = (record.replay + text).slice(-ACCOUNT_LOGIN_REPLAY_CHARS);
		for (const viewer of record.viewers) {
			try {
				viewer.sendText(text);
			} catch {
				// a dead viewer is dropped on its close event
			}
		}
	}

	function stopProcess(record: LoginRecord): void {
		const proc = record.proc;
		if (!proc) return;
		record.proc = null;
		try {
			proc.kill("SIGTERM");
		} catch {
			// already gone
		}
		const force = deps.setTimer(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// already gone
			}
		}, KILL_GRACE_MS);
		void proc.exited.finally(() => {
			deps.clearTimer(force);
			try {
				proc.terminal.close();
			} catch {
				// already closed
			}
		});
	}

	function clearTimers(record: LoginRecord): void {
		for (const handle of [record.pollTimer, record.expiryTimer, record.lingerTimer]) {
			if (handle !== null) deps.clearTimer(handle);
		}
		record.pollTimer = null;
		record.expiryTimer = null;
		record.lingerTimer = null;
		record.abort.abort();
	}

	/** Stop everything this login owns; the staged dir goes too unless it became an account. */
	function teardown(record: LoginRecord): void {
		clearTimers(record);
		stopProcess(record);
		record.unregister?.();
		record.unregister = null;
		for (const viewer of record.viewers) {
			try {
				viewer.close(1000, "Sign-in closed");
			} catch {
				// already closed
			}
		}
		record.viewers.clear();
		if (record.state.phase !== "succeeded") {
			const discarded = deps.discard(record.state.kind, record.accountId);
			log.info("Staged login dir released", { kind: record.state.kind, loginId: shortId(record.state.loginId), discarded });
		}
	}

	function schedulePoll(record: LoginRecord): void {
		record.pollTimer = deps.setTimer(() => {
			record.pollTimer = null;
			void poll(record);
		}, ACCOUNT_LOGIN_POLL_MS);
	}

	async function poll(record: LoginRecord): Promise<void> {
		if (byKind.get(record.state.kind) !== record || !WATCHED_PHASES.has(record.state.phase)) return;
		if (deps.hasIdentity(record.state.kind, record.accountId)) await verify(record);
		if (byKind.get(record.state.kind) === record && WATCHED_PHASES.has(record.state.phase)) schedulePoll(record);
	}

	async function verify(record: LoginRecord): Promise<void> {
		if (record.completing || deps.now() < record.nextVerifyAt) return;
		record.completing = true;
		const resumePhase = record.state.phase;
		setPhase(record, "verifying");
		const current = () => byKind.get(record.state.kind) === record && !record.abort.signal.aborted;
		try {
			const account = await deps.complete(record.state.kind, record.accountId, { signal: record.abort.signal, stillWanted: current });
			if (!current()) return;
			clearTimers(record);
			setPhase(record, "succeeded", { account, error: null, pending: null });
			// Claude stays in its REPL after /login; Codex exits on its own.
			record.lingerTimer = deps.setTimer(() => {
				record.lingerTimer = null;
				stopProcess(record);
			}, ACCOUNT_LOGIN_SUCCESS_LINGER_MS);
		} catch (err) {
			if (!current()) return;
			if (err instanceof accounts.LoginNotReadyError) {
				// A probe that did not confirm costs a CLI start: back off instead of retrying every poll.
				if (err.reason) record.nextVerifyAt = deps.now() + ACCOUNT_LOGIN_PROBE_BACKOFF_MS;
				// The process may have exited while we were verifying.
				const back = record.proc ? "running" : resumePhase === "missing-executable" ? "missing-executable" : "exited";
				setPhase(record, back, { pending: err.reason ?? null });
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			log.warn("Account login verification failed", { kind: record.state.kind, loginId: shortId(record.state.loginId), error: message });
			clearTimers(record);
			stopProcess(record);
			setPhase(record, "failed", { error: message });
		} finally {
			record.completing = false;
		}
	}

	function viewerSession(record: LoginRecord) {
		return {
			attach(viewer: ExternalPtyViewer) {
				record.viewers.add(viewer);
				if (record.replay) {
					try {
						// A reconnecting terminal still shows the old frames; replay onto a clean screen.
						viewer.sendText(`\x1b[H\x1b[2J${record.replay}`);
					} catch {
						// closed between open and replay
					}
				}
			},
			input(_viewer: ExternalPtyViewer, data: string) {
				record.proc?.terminal.write(data);
			},
			resize(_viewer: ExternalPtyViewer, cols: number, rows: number) {
				record.proc?.terminal.resize(cols, rows);
			},
			detach(viewer: ExternalPtyViewer) {
				record.viewers.delete(viewer);
			},
		};
	}

	async function launch(record: LoginRecord, prepared: PreparedAccountLogin): Promise<void> {
		const { kind } = record.state;
		const resolved = await deps.resolveExecutable(kind, prepared.launch.command);
		if (!resolved) {
			setPhase(record, "missing-executable", { sessionKey: null });
			return;
		}
		const argv = loginArgv(resolved, prepared.launch.args, deps.platform, deps.env);
		try {
			const proc = deps.spawnLogin(argv, {
				cwd: prepared.launch.cwd,
				env: loginEnv(deps.env, prepared.launch.env, kind),
				cols: 100,
				rows: 30,
				onData: (data) => broadcast(record, data),
			});
			record.proc = proc;
			record.unregister = deps.registerViewerSession(record.state.sessionKey!, viewerSession(record));
			void proc.exited.then((code) => {
				if (record.proc !== proc) return;
				record.proc = null;
				if (byKind.get(kind) !== record || record.state.phase !== "running") return;
				broadcast(record, "\r\n");
				setPhase(record, "exited", { exitCode: code ?? null });
				// One look right away: a CLI that exits after writing the login should not wait a tick.
				void poll(record);
			});
			setPhase(record, "running");
		} catch (err) {
			log.warn("Account login process failed to start", { kind, loginId: shortId(record.state.loginId), error: String(err) });
			setPhase(record, "missing-executable", { sessionKey: null, error: err instanceof Error ? err.message : String(err) });
		}
	}

	async function start(kind: AgentAccountKind, opts: { remoteViewer: boolean }): Promise<AccountLoginState> {
		const existing = byKind.get(kind);
		// One sign-in per CLI at a time: a second window joins it instead of racing a
		// second OAuth callback (Codex binds one fixed localhost port).
		if (existing && ACTIVE_PHASES.has(existing.state.phase)) return { ...existing.state };
		if (existing) close(existing.state.loginId);
		try {
			deps.sweepAbandoned(kind);
		} catch (err) {
			log.warn("Abandoned sign-in sweep failed", { kind, error: String(err) });
		}

		const deviceAuth = kind === "codex" && (opts.remoteViewer || deps.headless);
		const prepared = await deps.prepare(kind, { deviceAuth });
		const startedAt = deps.now();
		const loginId = crypto.randomUUID();
		const record: LoginRecord = {
			accountId: prepared.accountId,
			proc: null,
			viewers: new Set(),
			replay: "",
			unregister: null,
			pollTimer: null,
			expiryTimer: null,
			lingerTimer: null,
			completing: false,
			nextVerifyAt: 0,
			abort: new AbortController(),
			state: {
				loginId,
				kind,
				phase: "running",
				sessionKey: `${ACCOUNT_LOGIN_SESSION_PREFIX}${loginId}`,
				deviceAuth,
				manualCommand: prepared.loginCommand,
				executable: prepared.launch.command,
				installUrl: installUrl(kind),
				exitCode: null,
				error: null,
				pending: null,
				account: null,
				startedAt,
				expiresAt: startedAt + ACCOUNT_LOGIN_TTL_MS,
			},
		};
		byKind.set(kind, record);
		log.info("Account login started", { kind, loginId: shortId(loginId), deviceAuth });
		await launch(record, prepared);
		record.expiryTimer = deps.setTimer(() => expire(record), ACCOUNT_LOGIN_TTL_MS);
		schedulePoll(record);
		return { ...record.state };
	}

	function expire(record: LoginRecord): void {
		record.expiryTimer = null;
		if (byKind.get(record.state.kind) !== record || !ACTIVE_PHASES.has(record.state.phase)) return;
		clearTimers(record);
		stopProcess(record);
		setPhase(record, "expired");
		const discarded = deps.discard(record.state.kind, record.accountId);
		log.info("Expired login dir released", { kind: record.state.kind, loginId: shortId(record.state.loginId), discarded });
	}

	function findById(loginId: string): LoginRecord | null {
		for (const record of byKind.values()) if (record.state.loginId === loginId) return record;
		return null;
	}

	/** Cancel or dismiss: the same teardown, whatever phase the login is in. */
	function close(loginId: string): void {
		const record = findById(loginId);
		if (!record) return;
		byKind.delete(record.state.kind);
		teardown(record);
		log.info("Account login closed", { kind: record.state.kind, loginId: shortId(loginId), phase: record.state.phase });
		deps.push(null, record.state.kind);
	}

	async function restart(loginId: string, opts: { remoteViewer: boolean }): Promise<AccountLoginState> {
		const record = findById(loginId);
		if (!record) throw new Error("This sign-in has already ended.");
		const kind = record.state.kind;
		close(loginId);
		return start(kind, opts);
	}

	function get(kind: AgentAccountKind): AccountLoginState | null {
		const record = byKind.get(kind);
		return record ? { ...record.state } : null;
	}

	/** App shutdown: stop owned processes, keep nothing staged behind. */
	function closeAll(): void {
		for (const record of [...byKind.values()]) close(record.state.loginId);
	}

	return { start, restart, close, get, closeAll };
}

export type AccountLoginManager = ReturnType<typeof createAccountLoginManager>;

async function resolveLoginExecutable(kind: AgentAccountKind, command: string): Promise<string | null> {
	const settings = await loadSettings();
	const override = agentBinaryPathOverride(`builtin-${kind}`, command, settings.agentBinaryPaths, settings.agentCustomBinaryPaths);
	if (override && isExecutableFile(override)) return override;
	return Bun.which(command, { PATH: process.env.PATH ?? "" }) ?? null;
}

function spawnLoginProcess(argv: string[], opts: LoginSpawnOptions): LoginProcess {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const proc = spawn(argv, {
		cwd: opts.cwd,
		env: opts.env,
		terminal: {
			cols: opts.cols,
			rows: opts.rows,
			data(_terminal: unknown, bytes: Uint8Array) {
				opts.onData(decoder.decode(bytes, { stream: true }));
			},
		},
	});
	const terminal = proc.terminal as LoginTerminal | undefined;
	if (!terminal) {
		proc.kill();
		throw new Error(`Bun ${Bun.version} returned no terminal for the sign-in process`);
	}
	return {
		terminal,
		exited: proc.exited.then((code) => code ?? null),
		kill: (signal) => proc.kill(signal),
	};
}

/**
 * `claude auth status` for one staged dir, with the same sanitized env as the
 * sign-in. Its stdout is parsed and dropped — never logged (it names the account).
 * Null on a missing CLI, a timeout or an abort: unavailable, never "signed in".
 */
async function runClaudeAuthStatus(configDir: string, signal: AbortSignal): Promise<{ exitCode: number | null; stdout: string } | null> {
	if (signal.aborted) return null;
	const resolved = await resolveLoginExecutable("claude", "claude");
	if (!resolved) return null;
	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn(loginArgv(resolved, ["auth", "status"], process.platform, process.env), {
			cwd: configDir,
			env: loginEnv(process.env, { CLAUDE_CONFIG_DIR: configDir }, "claude"),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch (err) {
		log.warn("claude auth status failed to start", { error: String(err) });
		return null;
	}
	let cutShort = false;
	const stop = () => {
		cutShort = true;
		try {
			proc.kill();
		} catch {
			// already exited
		}
	};
	const timer = setTimeout(stop, ACCOUNT_LOGIN_PROBE_TIMEOUT_MS);
	signal.addEventListener("abort", stop, { once: true });
	try {
		const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout as ReadableStream).text()]);
		return cutShort ? null : { exitCode, stdout };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
	}
}

let pushHook: ((name: string, payload: unknown) => void) | null = null;

/** Wired by each entry point (desktop window + browsers, or browsers alone). */
export function setAccountLoginPush(fn: (name: string, payload: unknown) => void): void {
	pushHook = fn;
}

export const accountLogins = createAccountLoginManager({
	prepare: (kind, opts) => (kind === "claude" ? accounts.prepareClaudeLogin() : accounts.prepareCodexLogin(undefined, opts)),
	complete: (kind, id, ctx) =>
		kind === "claude"
			? accounts.completeClaudeLogin(id, accounts.defaultAccountPaths(), runClaudeAuthStatus, ctx)
			: accounts.completeCodexLogin(id, accounts.defaultAccountPaths(), ctx),
	hasIdentity: (kind, id) => accounts.stagedLoginHasIdentity(kind, id),
	discard: (kind, id) => accounts.discardStagedLogin(kind, id),
	sweepAbandoned: (kind) => void accounts.sweepAbandonedStagedLogins(kind, ACCOUNT_LOGIN_TTL_MS),
	resolveExecutable: resolveLoginExecutable,
	spawnLogin: spawnLoginProcess,
	// Called, not captured: suites that mock pty-server without this export still import us.
	registerViewerSession: (key, session) => registerExternalPtySession(key, session),
	push: (state, kind) => pushHook?.("accountLoginChanged", { kind, state }),
	now: () => Date.now(),
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	platform: process.platform,
	env: process.env,
	headless: process.env.DEV3_HEADLESS === "1",
});
