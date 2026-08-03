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
	boundCaptureLines,
	captureAge,
	captureIncarnation,
	clampHistoryLines,
	clampMaxBytes,
	knownFact,
	paneCaptureMiss,
	paneIdentityDrift,
	TERMINAL_CAPTURE_VERSION,
	unknownFact,
	type TerminalPaneCapture,
	type TerminalPaneCaptureIdentity,
	type TerminalPaneCaptureRequest,
	type TerminalPaneLiveness,
} from "./capture";
import {
	isTerminalLaunchSpec,
	isTerminalSessionId,
	isTerminalSize,
	terminalLaunchCommand,
	type TerminalAttachment,
	type TerminalBackend,
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
import { tmuxBackendPort, type TmuxBackendPort, type TmuxPaneObservation } from "./tmux-port";

function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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

	/**
	 * Read-only, and structurally incapable of side effects: it asks the server for
	 * one pane's rows and for tmux's own accounting of that pane. `select-pane`,
	 * `send-keys`, and `resize-window` are never on this path.
	 *
	 * tmux answers synchronously, so the text is true as of the read itself —
	 * `sourceUpdatedAt` equals `readAt` and a tmux capture is never stale. What tmux
	 * cannot answer is loss: it keeps no account of output it dropped, so `gaps`
	 * comes back unknown-with-reason instead of a zero that would read as "nothing
	 * was lost". The pane is observed BEFORE and AFTER the content read, so a pane
	 * that dies and is replaced mid-read is reported rather than impersonated.
	 */
	async captureView(
		id: TerminalSessionId,
		viewId: TerminalViewId,
		request: TerminalPaneCaptureRequest = {},
	): Promise<TerminalPaneCapture> {
		const blind: TerminalPaneCaptureIdentity = {
			backend: this.kind,
			sessionId: id,
			viewId,
			incarnation: unknownFact("the pane was not observed"),
			epoch: unknownFact("the pane was not observed"),
		};
		if (!isTerminalSessionId(id)) {
			return paneCaptureMiss(blind, "session-absent", `session id ${JSON.stringify(id)} is not portable`);
		}
		if (!(await this.presentForCapture(id))) {
			return paneCaptureMiss(blind, "session-absent", `tmux has no session ${JSON.stringify(id)}`);
		}

		let before: TmuxPaneObservation | null;
		try {
			before = await this.port.observePane(id, viewId);
		} catch (err) {
			return paneCaptureMiss(blind, "unreadable", `tmux could not describe the pane: ${reasonOf(err)}`);
		}
		if (!before) {
			return paneCaptureMiss(blind, "view-absent", `pane ${JSON.stringify(viewId)} is not part of the session`);
		}

		const identity = this.captureIdentityOf(id, before);
		const liveness: TerminalPaneLiveness = before.dead ? "dead" : "live";
		const historyLines = clampHistoryLines(request.historyLines);
		const maxBytes = clampMaxBytes(request.maxBytes);
		// A full-screen program owns the screen and freezes the pane's scrollback, so
		// history there is not recent output — it is whatever was on screen before that
		// program started. Report it absent by nature rather than as stale activity.
		const alternate = before.alternateScreen;

		let viewport: string[];
		let history: string[];
		try {
			viewport = await this.port.captureViewport(viewId);
			history = alternate ? [] : await this.port.captureHistory(viewId, historyLines);
		} catch (err) {
			if (await this.paneIsGone(id, viewId)) {
				return paneCaptureMiss(identity, "view-absent", `pane ${JSON.stringify(viewId)} disappeared mid-capture`);
			}
			return paneCaptureMiss(identity, "unreadable", `tmux capture failed: ${reasonOf(err)}`, liveness);
		}

		let after: TmuxPaneObservation | null;
		try {
			after = await this.port.observePane(id, viewId);
		} catch (err) {
			return paneCaptureMiss(identity, "unreadable", `the pane could not be re-checked: ${reasonOf(err)}`, liveness);
		}
		if (!after) {
			return paneCaptureMiss(identity, "view-absent", `pane ${JSON.stringify(viewId)} disappeared mid-capture`, liveness);
		}
		const drift = paneIdentityDrift(identity, this.captureIdentityOf(id, after));
		if (drift) return paneCaptureMiss(identity, "replaced", `the pane was replaced mid-capture: ${drift}`, liveness);

		const readAt = new Date().toISOString();
		const sourceUpdatedAt = knownFact(readAt);
		const bounded = boundCaptureLines(
			{ viewport, history, historyAvailable: alternate ? 0 : after.historySize },
			{ historyLines, maxBytes },
		);
		const age = captureAge(sourceUpdatedAt, readAt);
		return {
			version: TERMINAL_CAPTURE_VERSION,
			identity,
			readAt,
			availability: "captured",
			sourceUpdatedAt,
			ageMs: age.ageMs,
			liveness,
			size: knownFact({ cols: after.cols, rows: after.rows }),
			screen: knownFact(alternate ? "alternate" : "normal"),
			content: bounded.content,
			bounds: bounded.bounds,
			gaps: unknownFact("tmux keeps no account of output it dropped"),
			issues: [
				...bounded.issues,
				...age.issues,
				{
					code: "unknown" as const,
					detail: "tmux cannot say whether output was dropped, or whether the screen was reset",
				},
			],
		};
	}

	/**
	 * tmux's pane id, its process, and the server's epoch — hashed, so no pid
	 * leaves the seam. The epoch is there because tmux has no per-process start
	 * signature: without it a reused pid under a restarted server (where `%N` ids
	 * begin again) would compare equal to a completely different pane.
	 */
	private captureIdentityOf(
		id: TerminalSessionId,
		pane: TmuxPaneObservation,
	): TerminalPaneCaptureIdentity {
		return {
			backend: this.kind,
			sessionId: id,
			viewId: pane.paneId,
			incarnation: knownFact(captureIncarnation(pane.serverEpoch, pane.paneId, pane.pid)),
			// tmux has no pane-set generation: panes come and go without any counter the
			// server exposes, so an epoch here would be invented rather than observed.
			epoch: unknownFact("tmux publishes no pane-set generation"),
		};
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
			() => this.port.splitPane(from, { cwd: spec.cwd, env: spec.env, command }, spec.orientation),
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

	/** Presence for a capture: a failed probe is "cannot see it", never a throw. */
	private async presentForCapture(id: TerminalSessionId): Promise<boolean> {
		try {
			return await this.port.hasSession(id);
		} catch {
			return false;
		}
	}

	private async paneIsGone(id: TerminalSessionId, viewId: TerminalViewId): Promise<boolean> {
		try {
			if (!(await this.port.hasSession(id))) return true;
			const panes = await this.port.listPanes(id);
			return !panes.some((pane) => pane.paneId === viewId);
		} catch {
			return false; // cannot prove it is gone — keep the original diagnosis
		}
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
