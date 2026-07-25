/**
 * A task's primary terminal running on the native backend (seq 1292).
 *
 * Lifecycle (create / presence / teardown) goes through the merged product seam,
 * so nothing here knows about registry records or tmux. Live BYTES do not: the
 * seam deliberately keeps streaming above itself, so one long-lived
 * {@link NativeSessionClient} per session carries output, input, and resize — the
 * exact role the single attached tmux client plays on the legacy path.
 *
 * Two properties this module exists to guarantee:
 *  • The app holds exactly ONE writer client per session. Every renderer (desktop
 *    window, remote browser tab) multiplexes through it, and any other process
 *    that attaches is an observer the host refuses input and resize from.
 *  • Reattach never respawns. A fresh app process rediscovers the session by its
 *    deterministic id; the host replays its bounded output journal to the newly
 *    attached client, so the screen comes back without a second shell.
 */

import { createLogger } from "./logger";
import { NativeSessionClient } from "./native-terminal-registry/client";
import { readRecord } from "./native-terminal-registry/record";
import {
	nativeTaskSessionId,
	nativeTaskTerminalBackend,
	type TerminalLaunchSpec,
} from "./task-terminal-backend";
import { resolveNativeHostRuntime } from "./native-host-runtime";

const log = createLogger("native-task-terminal");

export interface NativeTaskTerminalHooks {
	/** Raw PTY bytes, in order, exactly as the shell produced them. */
	onOutput: (bytes: Uint8Array) => void;
	/** The shell exited or the host went away — the terminal is dead. */
	onClosed: () => void;
}

export interface NativeTaskTerminalSpec extends NativeTaskTerminalHooks {
	taskId: string;
	cwd: string;
	env: Record<string, string>;
	launch: TerminalLaunchSpec;
	cols: number;
	rows: number;
}

/** The app's live write/resize/read binding to one native task terminal. */
export interface NativeTaskTerminal {
	readonly sessionId: string;
	/** The host's pane identity — the same string every viewer of this shell sees. */
	readonly paneId: string;
	readonly hostPid: number;
	readonly shellPid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** Drop our client. The host, shell, and agent keep running. */
	detach(): void;
}

/**
 * The app must be the WRITER: an observer's input and resize are silently dropped
 * by the host, which would look like a dead terminal in the UI. If another process
 * got the lease first, claim it once and say so loudly when the claim is refused.
 */
async function ensureWriter(sessionId: string, client: NativeSessionClient): Promise<void> {
	if (client.getRole() === "writer") return;
	try {
		const reply = await client.claimWriter();
		if (reply.role === "writer") {
			log.info("Claimed the native writer lease", { sessionId });
			return;
		}
	} catch (err) {
		log.error("Claiming the native writer lease failed", { sessionId, error: String(err) });
		return;
	}
	log.error("Attached as OBSERVER; the host will drop this terminal's input and resize", { sessionId });
}

function bind(
	sessionId: string,
	client: NativeSessionClient,
	hooks: NativeTaskTerminalHooks,
): NativeTaskTerminal {
	const record = readRecord(sessionId);
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		hooks.onClosed();
	};
	client.onOutput(hooks.onOutput);
	// A refused write/resize arrives as a host error frame, never as a throw — without
	// this hook an observer-role terminal would fail completely silently.
	client.onError((error) => {
		log.warn("Native host refused a request", { sessionId, code: error.code, message: error.message ?? "" });
	});
	// The host closes the socket when the shell exits or the host itself stops, so
	// one disconnect hook covers every way this terminal can die.
	client.onDisconnect(close);
	return {
		sessionId,
		paneId: record?.paneId ?? `${sessionId}:0`,
		hostPid: record?.host.pid ?? -1,
		shellPid: record?.shell.pid ?? -1,
		write(data) {
			client.input(data);
		},
		resize(cols, rows) {
			client.resize(cols, rows);
		},
		detach() {
			closed = true; // an intentional detach is not a death
			client.close();
		},
	};
}

/**
 * Create the task's native session and attach to it. Fails loudly when this
 * build has no launchable host runtime — the caller must surface that, never
 * start tmux instead.
 */
export async function startNativeTaskTerminal(spec: NativeTaskTerminalSpec): Promise<NativeTaskTerminal> {
	const sessionId = nativeTaskSessionId(spec.taskId);
	const runtime = resolveNativeHostRuntime();
	log.info("Starting native task terminal", {
		taskId: spec.taskId.slice(0, 8),
		sessionId,
		runtime: runtime.kind,
		origin: runtime.origin,
		cols: spec.cols,
		rows: spec.rows,
	});
	const backend = nativeTaskTerminalBackend();
	await backend.openSession({
		id: sessionId,
		cwd: spec.cwd,
		env: spec.env,
		launch: spec.launch,
		size: { cols: spec.cols, rows: spec.rows },
	});
	const client = await NativeSessionClient.discover(sessionId);
	const terminal = bind(sessionId, client, spec);
	await ensureWriter(sessionId, client);
	log.info("Native task terminal started", {
		taskId: spec.taskId.slice(0, 8),
		hostPid: terminal.hostPid,
		shellPid: terminal.shellPid,
	});
	return terminal;
}

/**
 * Reattach to the task's existing native session, or `null` when there is none
 * that this app still owns. The host replays its bounded journal to us, so the
 * renderer repaints without any capture/replay logic here.
 */
export async function attachNativeTaskTerminal(
	taskId: string,
	hooks: NativeTaskTerminalHooks,
): Promise<NativeTaskTerminal | null> {
	const sessionId = nativeTaskSessionId(taskId);
	const backend = nativeTaskTerminalBackend();
	if (!(await backend.describeSession(sessionId))) return null;
	const client = await NativeSessionClient.discover(sessionId);
	const terminal = bind(sessionId, client, hooks);
	await ensureWriter(sessionId, client);
	log.info("Native task terminal reattached", {
		taskId: taskId.slice(0, 8),
		hostPid: terminal.hostPid,
		shellPid: terminal.shellPid,
	});
	return terminal;
}

/** True when a native session for this task is present and still owned by us. */
export async function nativeTaskTerminalAlive(taskId: string): Promise<boolean> {
	const backend = nativeTaskTerminalBackend();
	return (await backend.describeSession(nativeTaskSessionId(taskId))) !== null;
}

/**
 * Tear down exactly this task's native tree. Idempotent; touches nothing else.
 *
 * `ignoreMissing` makes "already gone" a success, but it ALSO makes an unconfirmed
 * teardown one — and a still-dying host would make the next launch of this task
 * fail with `session-exists`, since the session id is deterministic. So the result
 * is verified and an unconfirmed teardown is reported as the failure it is.
 */
export async function stopNativeTaskTerminal(taskId: string): Promise<void> {
	const sessionId = nativeTaskSessionId(taskId);
	const backend = nativeTaskTerminalBackend();
	await backend.cleanupSession(sessionId, { ignoreMissing: true });
	if (await backend.describeSession(sessionId)) {
		throw new Error(
			`native session ${sessionId} is still present after teardown — its host or shell did not exit`,
		);
	}
	log.info("Native task terminal stopped", { taskId: taskId.slice(0, 8), sessionId });
}
