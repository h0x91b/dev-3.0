/**
 * Native single-view terminal adapter (MIG-002 tracer, seq 1254).
 *
 * Composes the already-merged native primitives — the persistent session
 * registry (`start`/`status`/`stop`), the attach client, the versioned record
 * (stable session + pane ids), passive ownership classification, and the host's
 * bounded parser-state snapshot — into ONE cohesive single-view lifecycle that
 * satisfies the backend-neutral `ParityRunner` shape (see
 * `../terminal-parity/runner.ts`). It is deliberately duck-typed to that shape
 * rather than importing it, so this module stays a self-contained composition
 * with no dependency on the test-only corpus.
 *
 * SCOPE: this adapter has NO product callers (guarded by
 * `__tests__/isolation.test.ts`). It introduces no `TerminalBackend`, backend
 * selection, persisted backend marker, feature flag, migration, or fallback,
 * and it never inspects, attaches to, or modifies any tmux session. Multi-view
 * (split/focus of a second view) is intentionally deferred to LAY-003/LAY-004;
 * `splitView` raises a typed {@link MultiViewUnsupportedError}.
 *
 * Reconstruction uses the host's BOUNDED snapshot plus the sequencing rule's
 * monotonic-watermark half (see `./view-reconstruction.ts`); the full
 * gap → one-snapshot resync rule lives in `./stream-resync.ts`.
 */

import { NativeSessionClient } from "../native-terminal-registry/client";
import { classifyOwnership } from "../native-terminal-registry/ownership";
import { isValidSessionId } from "../native-terminal-registry/paths";
import { readParserState } from "../native-terminal-registry/parser-state";
import { readRecord, readToken, type NativeSessionRecord } from "../native-terminal-registry/record";
import { start, stop, type RegistryDeps } from "../native-terminal-registry/registry";
import {
	defaultNativeShellLaunchSpec,
	defineShellLaunchSpec,
	type ShellLaunchSpec,
} from "../native-terminal-registry/shell-launch";
import { MonotonicSnapshotView, type SnapshotReader } from "./view-reconstruction";
import { MultiViewUnsupportedError, NativeSessionNotFoundError, NativeViewGoneError } from "./errors";

/** Carriage return = the Enter key delivered to a raw PTY (termios maps CR→LF). */
const INPUT_SUBMIT = "\r";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface CreateSessionOptions {
	id: string;
	cwd: string;
	env?: Record<string, string>;
	command?: string;
}

export interface SplitViewOptions {
	cwd: string;
	env?: Record<string, string>;
	command?: string;
}

export interface ViewInfo {
	readonly id: string;
	readonly active: boolean;
}

export interface CaptureOptions {
	includeHistory?: boolean;
}

export interface CleanupOptions {
	bestEffort?: boolean;
}

export interface SessionHandle {
	readonly id: string;
	readonly firstViewId: string;
}

/** Injectable seams so the adapter's mapping is unit-testable without real hosts. */
export interface NativeAdapterDeps {
	start: typeof start;
	stop: typeof stop;
	readRecord: typeof readRecord;
	readToken: typeof readToken;
	classifyOwnership: typeof classifyOwnership;
	readSnapshot: SnapshotReader;
	connect: (record: NativeSessionRecord, token: string) => Promise<NativeSessionClient>;
	registryDeps?: RegistryDeps;
}

async function defaultConnect(record: NativeSessionRecord, token: string): Promise<NativeSessionClient> {
	const client = new NativeSessionClient();
	await client.connect(record, token, { timeoutMs: 5000 });
	return client;
}

export interface NativeSingleViewAdapterOptions {
	/** Only the owner tears down the sessions it created on dispose. */
	owner?: boolean;
	deps?: Partial<NativeAdapterDeps>;
}

interface Attachment {
	view: MonotonicSnapshotView;
	client: NativeSessionClient | null;
}

export class NativeSingleViewAdapter {
	readonly backend = "native";
	private readonly owner: boolean;
	private readonly deps: NativeAdapterDeps;
	private readonly created = new Set<string>();
	private readonly attachments = new Map<string, Attachment>();

	constructor(options: NativeSingleViewAdapterOptions = {}) {
		this.owner = options.owner ?? true;
		this.deps = {
			start: options.deps?.start ?? start,
			stop: options.deps?.stop ?? stop,
			readRecord: options.deps?.readRecord ?? readRecord,
			readToken: options.deps?.readToken ?? readToken,
			classifyOwnership: options.deps?.classifyOwnership ?? classifyOwnership,
			readSnapshot: options.deps?.readSnapshot ?? readParserState,
			connect: options.deps?.connect ?? defaultConnect,
			registryDeps: options.deps?.registryDeps,
		};
	}

	async createSession(opts: CreateSessionOptions): Promise<SessionHandle> {
		const launch = this.buildLaunchSpec(opts.cwd, opts.env, opts.command);
		const result = await this.deps.start(
			opts.id,
			{ launch, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, liveParser: true },
			this.deps.registryDeps,
		);
		this.created.add(opts.id);
		this.attachmentFor(opts.id);
		return { id: opts.id, firstViewId: result.record.paneId };
	}

	async isSessionPresent(id: string): Promise<boolean> {
		return (await this.ownedRecord(id)) !== null;
	}

	async listViews(id: string): Promise<ViewInfo[]> {
		const record = await this.ownedRecord(id);
		return record ? [{ id: record.paneId, active: true }] : [];
	}

	async activeViewId(id: string): Promise<string | null> {
		const record = await this.ownedRecord(id);
		return record ? record.paneId : null;
	}

	splitView(_id: string, _from: string, _opts: SplitViewOptions): Promise<ViewInfo> {
		return Promise.reject(new MultiViewUnsupportedError("splitView"));
	}

	async focusView(id: string, view: string): Promise<void> {
		const record = await this.ownedRecord(id);
		if (!record) throw new NativeSessionNotFoundError(id);
		// Focusing the sole live view is a no-op success; a second view would be
		// multi-view territory (deferred).
		if (view !== record.paneId) throw new MultiViewUnsupportedError("focusView on a second view");
	}

	async sendInput(id: string, view: string, text: string): Promise<void> {
		const record = await this.ownedRecord(id);
		if (!record) throw new NativeSessionNotFoundError(id);
		if (view !== record.paneId) throw new NativeViewGoneError(id, view);
		const client = await this.ensureClient(id, record);
		client.input(text + INPUT_SUBMIT);
	}

	async capture(id: string, view: string, opts: CaptureOptions = {}): Promise<string> {
		const record = await this.ownedRecord(id);
		if (!record) throw new NativeSessionNotFoundError(id);
		if (view !== record.paneId) throw new NativeViewGoneError(id, view);
		const { view: surface } = this.attachmentFor(id);
		return surface.capture(opts.includeHistory ?? false) ?? "";
	}

	/** Single-view: the sole view IS the session, so killing it tears down the session. */
	killView(id: string, _view: string, opts: CleanupOptions = {}): Promise<void> {
		return this.cleanupSession(id, opts);
	}

	async cleanupSession(id: string, opts: CleanupOptions = {}): Promise<void> {
		const bestEffort = opts.bestEffort ?? false;
		if (!isValidSessionId(id) || this.deps.readRecord(id) === null) {
			if (bestEffort) return;
			throw new NativeSessionNotFoundError(id);
		}
		await this.detach(id);
		const gone = await this.deps.stop(id, {}, this.deps.registryDeps);
		this.created.delete(id);
		this.attachments.delete(id);
		if (!gone && !bestEffort) {
			throw new Error(`native session ${JSON.stringify(id)} teardown could not be confirmed`);
		}
	}

	/** A fresh controller on the same on-disk namespace (models a new process). */
	reconnect(): NativeSingleViewAdapter {
		return new NativeSingleViewAdapter({ owner: false, deps: this.deps });
	}

	async dispose(): Promise<void> {
		for (const id of this.attachments.keys()) await this.detach(id);
		this.attachments.clear();
		if (!this.owner) return;
		for (const id of [...this.created]) {
			await this.deps.stop(id, {}, this.deps.registryDeps).catch(() => {});
		}
		this.created.clear();
	}

	private buildLaunchSpec(cwd: string, env: Record<string, string> | undefined, command: string | undefined): ShellLaunchSpec {
		const executable = command?.trim();
		if (executable) {
			return defineShellLaunchSpec({ executable, argv: [], cwd, env: env ?? {} });
		}
		const spec = defaultNativeShellLaunchSpec({ platform: process.platform, cwd, env: process.env });
		return defineShellLaunchSpec({ ...spec, env: env ?? {} });
	}

	private attachmentFor(id: string): Attachment {
		let attachment = this.attachments.get(id);
		if (!attachment) {
			attachment = { view: new MonotonicSnapshotView(id, this.deps.readSnapshot), client: null };
			this.attachments.set(id, attachment);
		}
		return attachment;
	}

	private async ensureClient(id: string, record: NativeSessionRecord): Promise<NativeSessionClient> {
		const attachment = this.attachmentFor(id);
		if (attachment.client) return attachment.client;
		const token = this.deps.readToken(id);
		if (!token) throw new NativeSessionNotFoundError(id);
		attachment.client = await this.deps.connect(record, token);
		return attachment.client;
	}

	private async detach(id: string): Promise<void> {
		const attachment = this.attachments.get(id);
		if (!attachment?.client) return;
		try {
			attachment.client.close();
		} catch {
			// already closed
		}
		attachment.client = null;
	}

	/** The record iff the session is present AND still ours (owned + alive). */
	private async ownedRecord(id: string): Promise<NativeSessionRecord | null> {
		if (!isValidSessionId(id)) return null;
		const record = this.deps.readRecord(id);
		if (!record) return null;
		const verdict = await this.deps.classifyOwnership(record, this.deps.readToken(id));
		return verdict === "owned" ? record : null;
	}
}
