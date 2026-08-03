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
import { HostRefusedError, NativeSessionClient, OwnershipTimeoutError } from "./native-terminal-registry/client";
import type { WriterTakeoverRefusal } from "../shared/native-terminal-stream";
import { nativeBoundIdentityOf, type NativeBoundIdentity } from "./native-pane-identity";
import type { ClientRole } from "./native-terminal-registry/writer-ownership";

const log = createLogger("native-task-terminal");

export interface NativeTaskTerminalHooks {
	/** Raw PTY bytes, in order, exactly as the shell produced them. */
	onOutput: (bytes: Uint8Array) => void;
	/** The shell exited or the host went away — the terminal is dead. */
	onClosed: () => void;
	/**
	 * The host changed this process's role on its own — it inherited the lease
	 * because the previous writer disconnected. Viewers are still showing the old
	 * role until someone republishes it.
	 */
	onRoleChange?: (role: ClientRole) => void;
	/**
	 * The WRITER — possibly in another app process — resized the shared PTY. Our own
	 * viewers are still rendering at the previous grid until someone republishes it.
	 */
	onGeometry?: (size: { cols: number; rows: number }) => void;
}

/**
 * Discriminated on `ok`, never on a role. A cached role can say `writer` while the host
 * has already moved the lease, so branching on it let a failed or timed-out takeover be
 * read as success and skip compensation entirely.
 */
export type WriterTakeoverResult =
	| { ok: true }
	| {
		ok: false;
		refusal: WriterTakeoverRefusal;
		/**
		 * The host never answered in time, so it may STILL commit the takeover. Distinct
		 * from every other failure: the caller must compensate, not merely report.
		 */
		timedOut?: true;
	};

/** The app's live write/resize/read binding to one native pane. */
export interface NativeTaskTerminal {
	readonly sessionId: string;
	/** The host's logical pane identity. */
	readonly paneId: string;
	readonly hostPid: number;
	readonly shellPid: number;
	/** Registry-proved identity captured at bind time; see {@link NativeBoundIdentity}. */
	readonly boundIdentity: NativeBoundIdentity | null;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/**
	 * Resize and resolve only once the HOST has applied it, reporting the size it
	 * actually adopted. Rejects when the host refuses (a stale lease belief) or never
	 * answers — the caller must then leave its canonical geometry untouched.
	 */
	resizeAwaited(cols: number, rows: number): Promise<{ cols: number; rows: number }>;
	/**
	 * What the HOST granted this app process — not what our own viewers agreed
	 * among themselves. Another dev3 instance may hold the lease, and everything
	 * an observer writes is dropped on the floor.
	 */
	hostRole(): ClientRole;
	/** Whether ANY process holds the lease; null while the host has not said. */
	hostWriterAttached(): boolean | null;
	/** The writer's canonical grid as the HOST reports it; null until it has. */
	hostPtyGeometry(): { cols: number; rows: number } | null;
	/** Ask the host for the lease. Refused while another process still holds it. */
	claimHostWriter(): Promise<ClientRole>;
	/**
	 * Ask the host for the VACANT slot, distinguishing the answers. `writer` = it was
	 * free and is ours; `writer-active` = the host authoritatively says someone holds it;
	 * `failed` = we never got an answer, which says nothing about who owns it.
	 */
	claimHostWriterDiscriminated(): Promise<{ outcome: "writer" | "writer-active" | "failed" }>;
	/**
	 * Displace the live writer — the explicit `Take control` gesture, and the only
	 * path that moves a lease between app processes.
	 */
	takeoverHostWriter(): Promise<WriterTakeoverResult>;
	/**
	 * Hand the host lease back so it is not stranded in a process nobody is viewing.
	 * Resolves `false` when the host never confirmed — the caller must then get rid of
	 * the connection itself, or the lease stays held by a process that cannot use it.
	 */
	releaseHostWriter(): Promise<boolean>;
	/** Which app process holds the lease; `null` = vacant, `undefined` = unknown. */
	writerPid(): Promise<number | null | undefined>;
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
	// The record this socket was DIALLED with, never a fresh read: a successor's record
	// would describe a different process than the connection actually reaches.
	const record = client.connectedRecord();
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
	if (hooks.onGeometry) {
		const notify = hooks.onGeometry;
		client.onGeometry((size) => {
			log.info("Native host published a new canonical PTY size", { sessionId, ...size });
			notify(size);
		});
	}
	if (hooks.onRoleChange) {
		const notify = hooks.onRoleChange;
		client.onRoleChange((role) => {
			log.info("Native host changed this process's role", { sessionId, role });
			notify(role);
		});
	}
	const terminal: NativeTaskTerminal = {
		sessionId,
		paneId: paneId || record?.paneId || `${sessionId}:0`,
		hostPid: record?.host.pid ?? -1,
		shellPid: record?.shell.pid ?? -1,
		boundIdentity: nativeBoundIdentityOf(record),
		write(data) {
			client.input(data);
		},
		resize(cols, rows) {
			client.resize(cols, rows);
		},
		async resizeAwaited(cols, rows) {
			const ack = await client.resizeAwaited(cols, rows);
			return { cols: ack.cols, rows: ack.rows };
		},
		hostRole() {
			// A client that never got a role yet cannot be assumed to own the pane.
			return client.getRole() ?? "observer";
		},
		hostWriterAttached() {
			return client.getWriterAttached();
		},
		hostPtyGeometry() {
			return client.getPtyGeometry();
		},
		async claimHostWriter() {
			if (client.getRole() === "writer") return "writer";
			try {
				return (await client.claimWriter()).role;
			} catch (err) {
				log.warn("Claiming the native writer lease failed", { sessionId, error: String(err) });
				return client.getRole() ?? "observer";
			}
		},
		async claimHostWriterDiscriminated() {
			if (client.getRole() === "writer") return { outcome: "writer" as const };
			try {
				const reply = await client.claimWriter();
				return { outcome: reply.role === "writer" ? ("writer" as const) : ("writer-active" as const) };
			} catch (err) {
				// Only the host's own `conflict` verdict means the slot is genuinely taken, and
				// it is read off a TYPED error rather than matched in message text. A
				// disconnect, an auth failure or a timeout says nothing about the lease.
				const authoritative = err instanceof HostRefusedError && err.code === "conflict";
				log.warn("Native writer claim failed", { sessionId, error: String(err), authoritative });
				return { outcome: authoritative ? ("writer-active" as const) : ("failed" as const) };
			}
		},
		async takeoverHostWriter() {
			// NO short-circuit on our cached role: it can be stale, and skipping the request
			// would make an explicit gesture silently do nothing. The host's takeover is
			// idempotent for the true current writer, so always asking is safe.
			if (!client.supports("takeover")) {
				// This host cannot transfer at all, so a plain claim is the only option: it
				// still wins a VACANT slot. Only the host's authoritative "someone holds it"
				// is host-too-old; a failure we could not interpret stays transfer-failed.
				log.info("Host does not announce takeover; falling back to a claim", { sessionId });
				const { outcome } = await terminal.claimHostWriterDiscriminated();
				if (outcome === "writer") return { ok: true };
				return { ok: false, refusal: outcome === "writer-active" ? "host-too-old" : "transfer-failed" };
			}
			try {
				const reply = await client.takeoverWriter();
				log.info("Took over the native writer lease", { sessionId, role: reply.role });
				// The HOST's answer decides, not our cache: a reply of `observer` is a refusal.
				if (reply.role !== "writer") return { ok: false, refusal: "transfer-failed" };
				return { ok: true };
			} catch (err) {
				// Every failure against a capable host is `transfer-failed`. The real cause is
				// logged and never shown, so the UI stays generic rather than guessing.
				const timedOut = err instanceof OwnershipTimeoutError;
				log.warn("Native writer takeover failed", { sessionId, error: String(err), timedOut });
				return { ok: false, refusal: "transfer-failed", ...(timedOut ? { timedOut: true as const } : {}) };
			}
		},
		async releaseHostWriter() {
			// NO short-circuit on the cached role. After an ambiguous timeout the cache says
			// observer while the host may have committed the takeover, and returning "released"
			// without sending anything let the caller skip its detach and strand the lease.
			try {
				const reply = await client.releaseWriter();
				log.info("Released the native writer lease", { sessionId });
				return reply.role === "observer";
			} catch (err) {
				// Swallowing this would leave the lease held by a process that cannot use it,
				// locking every other dev3 window out of the pane. Report it so the caller
				// can drop the connection instead.
				log.warn("Releasing the native writer lease failed", { sessionId, error: String(err) });
				return false;
			}
		},
		async writerPid() {
			try {
				return (await client.status()).writerPid;
			} catch (err) {
				log.warn("Reading the native writer pid failed", { sessionId, error: String(err) });
				return undefined;
			}
		},
		detach() {
			closed = true;
			client.close();
		},
	};
	return terminal;
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
	opts: { discardReplay?: boolean } = {},
): Promise<NativeTaskTerminal | null> {
	const client = await NativeSessionClient.discover(sessionId).catch(() => null);
	if (!client) return null;
	// A REBIND keeps its bridge journal, so the host's replay is history it already has and
	// feeding it through would print the screen twice. Only the frames the host MARKED as
	// replay are dropped; an older host announces no boundary, and then everything is kept,
	// because duplicated history is recoverable while a lost marker is not.
	if (opts.discardReplay) {
		const dropped = client.discardReplayedOutput();
		if (dropped === null) {
			log.warn("Host announces no replay boundary; keeping its replay to avoid losing live output", { sessionId });
		} else {
			log.info("Discarded the host replay on rebind; the bridge already holds it", { sessionId, dropped });
		}
	}
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
