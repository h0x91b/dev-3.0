/**
 * Native implementation of the product {@link TerminalBackend} (MIG-002, seq 1280).
 *
 * A thin, honest wrapper around the already-merged `NativeSingleViewAdapter`:
 * it translates product vocabulary into that adapter's single-view lifecycle and
 * its typed errors into the contract's. Registry internals (records, tokens,
 * ownership, parser snapshots, sockets) stay behind the adapter — this file
 * imports nothing from the registry, so the seam does not widen the native
 * module's reach.
 *
 * Multi-view (`splitView`, focusing a second view) returns the typed
 * `unsupported` failure until LAY-003/LAY-004 lands. That is a documented
 * boundary of THIS adapter, not a capability the caller must negotiate.
 */

import {
	NativeAdapterError,
	NativeSingleViewAdapter,
	type NativeAdapterDeps,
} from "../native-terminal-adapter";
import {
	isTerminalLaunchSpec,
	isTerminalSessionId,
	isTerminalSize,
	type TerminalAttachment,
	type TerminalBackend,
	type TerminalCapture,
	type TerminalCaptureOptions,
	type TerminalSessionId,
	type TerminalSessionSpec,
	type TerminalSessionState,
	type TerminalSize,
	type TerminalTeardownOptions,
	type TerminalViewId,
	type TerminalViewSpec,
	type TerminalViewState,
} from "./contract";
import {
	attachmentReleased,
	backendFailure,
	invalidLaunch,
	invalidSessionId,
	invalidSize,
	sessionExists,
	sessionNotFound,
	unsupported,
	viewNotFound,
	type TerminalBackendError,
} from "./errors";

const MULTI_VIEW_REASON = "the native backend serves one view per session until LAY-003/LAY-004";

export interface NativeTerminalBackendOptions {
	/** Injectable native seams — tests pass fakes, production uses the defaults. */
	deps?: Partial<NativeAdapterDeps>;
}

/** Translate an adapter failure into the contract's typed error. */
function translate(
	operation: string,
	err: unknown,
	sessionId: TerminalSessionId,
	viewId?: TerminalViewId,
): TerminalBackendError {
	if (err instanceof NativeAdapterError) {
		if (err.code === "session-not-found") return sessionNotFound(sessionId);
		if (err.code === "view-gone") return viewNotFound(sessionId, viewId ?? "<unknown>");
		if (err.code === "multi-view-unsupported") return unsupported(operation, MULTI_VIEW_REASON);
	}
	return backendFailure(operation, err, { sessionId, viewId });
}

export class NativeTerminalBackend implements TerminalBackend {
	readonly kind = "native" as const;
	private readonly adapter: NativeSingleViewAdapter;
	private readonly attachments = new Set<NativeAttachment>();

	constructor(options: NativeTerminalBackendOptions = {}) {
		// `owner: false` keeps session lifetime out of `dispose()`: sessions are
		// persistent and only `cleanupSession` may tear one down.
		this.adapter = new NativeSingleViewAdapter({ owner: false, deps: options.deps });
	}

	async openSession(spec: TerminalSessionSpec): Promise<TerminalSessionState> {
		if (!isTerminalSessionId(spec.id)) throw invalidSessionId(spec.id);
		if (spec.size && !isTerminalSize(spec.size)) throw invalidSize(spec.size);
		if (spec.launch && !isTerminalLaunchSpec(spec.launch)) throw invalidLaunch(spec.launch);
		if (await this.describeSession(spec.id)) throw sessionExists(spec.id);
		// The native host spawns the process itself, so geometry is part of the
		// launch instead of a resize after the shell has already painted once.
		const handle = await this.guard("openSession", spec.id, () =>
			this.adapter.createSession({
				id: spec.id,
				cwd: spec.cwd,
				env: spec.env as Record<string, string> | undefined,
				command: spec.command,
				launch: spec.launch,
				cols: spec.size?.cols,
				rows: spec.size?.rows,
			}),
		);
		return {
			id: spec.id,
			views: [{ id: handle.firstViewId, focused: true }],
			focusedViewId: handle.firstViewId,
		};
	}

	async describeSession(id: TerminalSessionId): Promise<TerminalSessionState | null> {
		if (!isTerminalSessionId(id)) return null;
		const views = await this.guard("describeSession", id, () => this.adapter.listViews(id));
		if (views.length === 0) return null;
		const mapped: TerminalViewState[] = views.map((view) => ({ id: view.id, focused: view.active }));
		return { id, views: mapped, focusedViewId: mapped.find((view) => view.focused)?.id ?? null };
	}

	async attachView(id: TerminalSessionId, viewId?: TerminalViewId): Promise<TerminalAttachment> {
		const state = await this.requireSession(id);
		const target = viewId ?? state.focusedViewId ?? state.views[0]?.id;
		if (!target) throw viewNotFound(id, viewId ?? "<focused>");
		if (!state.views.some((view) => view.id === target)) throw viewNotFound(id, target);
		const attachment = new NativeAttachment(id, target, this.adapter, (released) =>
			this.attachments.delete(released),
		);
		this.attachments.add(attachment);
		return attachment;
	}

	async focusView(id: TerminalSessionId, viewId: TerminalViewId): Promise<void> {
		await this.requireSession(id);
		await this.guard("focusView", id, () => this.adapter.focusView(id, viewId), viewId);
	}

	async splitView(
		id: TerminalSessionId,
		_from: TerminalViewId,
		_spec: TerminalViewSpec,
	): Promise<TerminalViewState> {
		await this.requireSession(id);
		throw unsupported("splitView", MULTI_VIEW_REASON);
	}

	async closeView(
		id: TerminalSessionId,
		viewId: TerminalViewId,
		opts: TerminalTeardownOptions = {},
	): Promise<void> {
		const ignoreMissing = opts.ignoreMissing ?? false;
		const state = await this.describeSession(id);
		if (!state) {
			if (ignoreMissing) return;
			throw sessionNotFound(id);
		}
		if (!state.views.some((view) => view.id === viewId)) {
			if (ignoreMissing) return;
			throw viewNotFound(id, viewId);
		}
		// The sole view IS the session, so closing it tears the session down.
		await this.guard(
			"closeView",
			id,
			() => this.adapter.killView(id, viewId, { bestEffort: ignoreMissing }),
			viewId,
		);
	}

	async cleanupSession(id: TerminalSessionId, opts: TerminalTeardownOptions = {}): Promise<void> {
		const ignoreMissing = opts.ignoreMissing ?? false;
		for (const attachment of [...this.attachments]) {
			if (attachment.sessionId === id) await attachment.detach();
		}
		await this.guard("cleanupSession", id, () =>
			this.adapter.cleanupSession(id, { bestEffort: ignoreMissing }),
		);
	}

	async dispose(): Promise<void> {
		for (const attachment of [...this.attachments]) await attachment.detach();
		this.attachments.clear();
		await this.adapter.dispose();
	}

	private async requireSession(id: TerminalSessionId): Promise<TerminalSessionState> {
		const state = await this.describeSession(id);
		if (!state) throw sessionNotFound(id);
		return state;
	}

	private async guard<T>(
		operation: string,
		sessionId: TerminalSessionId,
		run: () => Promise<T>,
		viewId?: TerminalViewId,
	): Promise<T> {
		try {
			return await run();
		} catch (err) {
			throw translate(operation, err, sessionId, viewId);
		}
	}
}

class NativeAttachment implements TerminalAttachment {
	private released = false;

	constructor(
		readonly sessionId: TerminalSessionId,
		readonly viewId: TerminalViewId,
		private readonly adapter: NativeSingleViewAdapter,
		private readonly onDetach: (attachment: NativeAttachment) => void,
	) {}

	write(data: string): Promise<void> {
		return this.run("write", () => this.adapter.writeInput(this.sessionId, this.viewId, data));
	}

	resize(size: TerminalSize): Promise<void> {
		if (!isTerminalSize(size)) return Promise.reject(invalidSize(size));
		return this.run("resize", () =>
			this.adapter.resizeView(this.sessionId, this.viewId, size.cols, size.rows),
		);
	}

	async capture(opts: TerminalCaptureOptions = {}): Promise<TerminalCapture> {
		const text = await this.run("capture", () =>
			this.adapter.capture(this.sessionId, this.viewId, {
				includeHistory: opts.includeScrollback ?? false,
			}),
		);
		return { viewId: this.viewId, text };
	}

	async detach(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.onDetach(this);
		await this.adapter.detachSession(this.sessionId);
	}

	private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
		if (this.released) throw attachmentReleased(this.sessionId, this.viewId);
		try {
			return await action();
		} catch (err) {
			throw translate(operation, err, this.sessionId, this.viewId);
		}
	}
}
