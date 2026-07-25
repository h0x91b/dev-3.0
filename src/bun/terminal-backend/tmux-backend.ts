/**
 * tmux implementation of the product {@link TerminalBackend} (MIG-002, seq 1280).
 *
 * Product logic only: id validation, presence and membership checks, focus
 * bookkeeping, and the mapping of tmux failures onto the contract's typed
 * errors. Every tmux command goes through {@link ./tmux-port} — no tmux name,
 * pane string, format, socket, or argv appears here, so callers of this class
 * cannot come to depend on tmux at all.
 *
 * This is the production backend's behavior expressed at the seam; it adds no
 * selection, flag, migration, or fallback and has no product callers yet.
 */

import {
	isTerminalLaunchSpec,
	isTerminalSessionId,
	isTerminalSize,
	terminalLaunchCommand,
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
	viewNotFound,
} from "./errors";
import { tmuxBackendPort, type TmuxBackendPort } from "./tmux-port";

/** tmux runs one shell-ready string, so a structured launch is quoted into one. */
function launchCommand(spec: TerminalSessionSpec | TerminalViewSpec): string | undefined {
	if (!spec.launch) return spec.command;
	if (!isTerminalLaunchSpec(spec.launch)) throw invalidLaunch(spec.launch);
	return terminalLaunchCommand(spec.launch);
}

export interface TmuxTerminalBackendOptions {
	/** Injectable tmux port — tests pass a fake, production uses the default. */
	port?: TmuxBackendPort;
}

export class TmuxTerminalBackend implements TerminalBackend {
	readonly kind = "tmux" as const;
	private readonly port: TmuxBackendPort;
	private readonly attachments = new Set<TmuxAttachment>();

	constructor(options: TmuxTerminalBackendOptions = {}) {
		this.port = options.port ?? tmuxBackendPort();
	}

	async openSession(spec: TerminalSessionSpec): Promise<TerminalSessionState> {
		if (!isTerminalSessionId(spec.id)) throw invalidSessionId(spec.id);
		if (spec.size && !isTerminalSize(spec.size)) throw invalidSize(spec.size);
		const command = launchCommand(spec);
		if (await this.present(spec.id)) throw sessionExists(spec.id);
		await this.guard("openSession", spec.id, () =>
			this.port.newSessionDetached(spec.id, { cwd: spec.cwd, env: spec.env, command }),
		);
		if (spec.size) {
			await this.guard("openSession.resize", spec.id, () =>
				this.port.resize(spec.id, spec.size!.cols, spec.size!.rows),
			);
		}
		const state = await this.describeSession(spec.id);
		if (!state) throw backendFailure("openSession", "session vanished right after creation", {
			sessionId: spec.id,
		});
		return state;
	}

	async describeSession(id: TerminalSessionId): Promise<TerminalSessionState | null> {
		if (!isTerminalSessionId(id)) return null;
		if (!(await this.present(id))) return null;
		const panes = await this.guard("describeSession", id, () => this.port.listPanes(id));
		if (panes.length === 0) return null;
		const views: TerminalViewState[] = panes.map((pane) => ({ id: pane.paneId, focused: pane.active }));
		return { id, views, focusedViewId: views.find((view) => view.focused)?.id ?? null };
	}

	async attachView(id: TerminalSessionId, viewId?: TerminalViewId): Promise<TerminalAttachment> {
		const state = await this.requireSession(id);
		const target = viewId ?? state.focusedViewId ?? state.views[0]?.id;
		if (!target) throw viewNotFound(id, viewId ?? "<focused>");
		if (!state.views.some((view) => view.id === target)) throw viewNotFound(id, target);
		const attachment = new TmuxAttachment(id, target, this.port, (released) =>
			this.attachments.delete(released),
		);
		this.attachments.add(attachment);
		return attachment;
	}

	async focusView(id: TerminalSessionId, viewId: TerminalViewId): Promise<void> {
		await this.requireView(id, viewId);
		await this.guard("focusView", id, () => this.port.selectPane(viewId), viewId);
	}

	async splitView(
		id: TerminalSessionId,
		from: TerminalViewId,
		spec: TerminalViewSpec,
	): Promise<TerminalViewState> {
		await this.requireView(id, from);
		const command = launchCommand(spec);
		const paneId = await this.guard(
			"splitView",
			id,
			() => this.port.splitPane(from, { cwd: spec.cwd, env: spec.env, command }),
			from,
		);
		const focusedViewId = await this.guard("splitView.focus", id, () => this.port.activePaneId(id));
		return { id: paneId, focused: focusedViewId === paneId };
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
		await this.guard("closeView", id, () => this.port.killPane(viewId, ignoreMissing), viewId);
	}

	async cleanupSession(id: TerminalSessionId, opts: TerminalTeardownOptions = {}): Promise<void> {
		const ignoreMissing = opts.ignoreMissing ?? false;
		if (!(await this.present(id))) {
			if (ignoreMissing) return;
			throw sessionNotFound(id);
		}
		for (const attachment of [...this.attachments]) {
			if (attachment.sessionId === id) await attachment.detach();
		}
		await this.guard("cleanupSession", id, () => this.port.killSession(id, ignoreMissing));
	}

	async dispose(): Promise<void> {
		for (const attachment of [...this.attachments]) await attachment.detach();
		this.attachments.clear();
	}

	private async present(id: TerminalSessionId): Promise<boolean> {
		if (!isTerminalSessionId(id)) return false;
		return this.guard("hasSession", id, () => this.port.hasSession(id));
	}

	private async requireSession(id: TerminalSessionId): Promise<TerminalSessionState> {
		const state = await this.describeSession(id);
		if (!state) throw sessionNotFound(id);
		return state;
	}

	private async requireView(id: TerminalSessionId, viewId: TerminalViewId): Promise<void> {
		const state = await this.requireSession(id);
		if (!state.views.some((view) => view.id === viewId)) throw viewNotFound(id, viewId);
	}

	/** Run a port call, translating any tmux-side failure into a typed error. */
	private async guard<T>(
		operation: string,
		sessionId: TerminalSessionId,
		run: () => Promise<T>,
		viewId?: TerminalViewId,
	): Promise<T> {
		try {
			return await run();
		} catch (err) {
			throw backendFailure(operation, err, { sessionId, viewId });
		}
	}
}

class TmuxAttachment implements TerminalAttachment {
	private released = false;

	constructor(
		readonly sessionId: TerminalSessionId,
		readonly viewId: TerminalViewId,
		private readonly port: TmuxBackendPort,
		private readonly onDetach: (attachment: TmuxAttachment) => void,
	) {}

	write(data: string): Promise<void> {
		return this.run("write", () => this.port.writePane(this.viewId, data));
	}

	resize(size: TerminalSize): Promise<void> {
		if (!isTerminalSize(size)) return Promise.reject(invalidSize(size));
		// tmux geometry lives on the window, so a resize applies to the session's
		// whole layout — a recorded intentional difference from per-view native.
		return this.run("resize", () => this.port.resize(this.sessionId, size.cols, size.rows));
	}

	async capture(opts: TerminalCaptureOptions = {}): Promise<TerminalCapture> {
		const text = await this.run("capture", () =>
			this.port.capturePane(this.viewId, opts.includeScrollback ?? false),
		);
		return { viewId: this.viewId, text };
	}

	async detach(): Promise<void> {
		this.released = true;
		this.onDetach(this);
	}

	/** Map a failed pane operation onto `view-not-found` when the pane is gone. */
	private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
		if (this.released) throw attachmentReleased(this.sessionId, this.viewId);
		try {
			return await action();
		} catch (err) {
			if (await this.viewIsGone()) throw viewNotFound(this.sessionId, this.viewId);
			throw backendFailure(operation, err, { sessionId: this.sessionId, viewId: this.viewId });
		}
	}

	private async viewIsGone(): Promise<boolean> {
		try {
			if (!(await this.port.hasSession(this.sessionId))) return true;
			const panes = await this.port.listPanes(this.sessionId);
			return !panes.some((pane) => pane.paneId === this.viewId);
		} catch {
			return false; // can't prove it's gone — keep the original failure
		}
	}
}
