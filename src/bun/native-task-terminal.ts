/**
 * Live byte-binding to one native pane (seq 1311, PR1).
 *
 * Lifecycle (create / teardown) moved to {@link ./native-task-panes}. This
 * module only binds one pane's bytes to a caller-supplied hooks object via
 * a single long-lived {@link NativeSessionClient}. It enforces the writer-lease
 * invariant: the app holds exactly ONE writer per pane; every other client is
 * an observer whose input and resize the host silently drops.
 *
 * Callers pass the registry session id (e.g. `dev3-task-<uuid>-pane-1`) —
 * they already own a started pane and just need a live I/O binding to it.
 */

import { createLogger } from "./logger";
import { NativeSessionClient } from "./native-terminal-registry/client";
import { readRecord } from "./native-terminal-registry/record";

const log = createLogger("native-task-terminal");

export interface NativeTaskTerminalHooks {
	/** Raw PTY bytes, in order, exactly as the shell produced them. */
	onOutput: (bytes: Uint8Array) => void;
	/** The shell exited or the host went away — the terminal is dead. */
	onClosed: () => void;
}

/** The app's live write/resize/read binding to one native pane. */
export interface NativeTaskTerminal {
	readonly sessionId: string;
	/** The host's logical pane identity. */
	readonly paneId: string;
	readonly hostPid: number;
	readonly shellPid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** Drop our client. The host, shell, and agent keep running. */
	detach(): void;
}

/**
 * The app must be the WRITER: an observer's input and resize are silently
 * dropped by the host. If another client got the lease first, claim it once
 * and log loudly when the claim is refused.
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
	log.error("Attached as OBSERVER; the host will drop this pane's input and resize", { sessionId });
}

function bindClient(
	sessionId: string,
	paneId: string,
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
	// A refused write/resize arrives as a host error frame — without this hook
	// an observer-role terminal fails completely silently.
	client.onError((error) => {
		log.warn("Native host refused a pane request", { sessionId, code: error.code, message: error.message ?? "" });
	});
	client.onDisconnect(close);
	return {
		sessionId,
		paneId: paneId || record?.paneId || `${sessionId}:0`,
		hostPid: record?.host.pid ?? -1,
		shellPid: record?.shell.pid ?? -1,
		write(data) {
			client.input(data);
		},
		resize(cols, rows) {
			client.resize(cols, rows);
		},
		detach() {
			closed = true;
			client.close();
		},
	};
}

/**
 * Bind to an already-started pane by its registry session id.
 * Returns `null` when the session no longer exists (the host already exited).
 *
 * The caller is responsible for creating the pane via
 * {@link ./native-task-panes.startNativeTaskPanes} /
 * {@link ./native-task-panes.recoverNativeTaskPanes} before calling this.
 */
export async function bindNativeTaskPane(
	sessionId: string,
	hooks: NativeTaskTerminalHooks,
	paneId = "",
): Promise<NativeTaskTerminal | null> {
	const client = await NativeSessionClient.discover(sessionId).catch(() => null);
	if (!client) return null;
	const terminal = bindClient(sessionId, paneId, client, hooks);
	await ensureWriter(sessionId, client);
	log.info("Native pane bound", {
		sessionId,
		paneId: terminal.paneId,
		hostPid: terminal.hostPid,
		shellPid: terminal.shellPid,
	});
	return terminal;
}
