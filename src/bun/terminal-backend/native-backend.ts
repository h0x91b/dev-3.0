/**
 * Native implementation of the product {@link TerminalBackend} (MIG-002, seq 1280).
 *
 * Coordinator-backed: one {@link NativeMultipaneCoordinator} per session id,
 * cached inside this instance. Multi-view is fully supported — split, focus,
 * and close all delegate to the coordinator's pane lifecycle. The
 * {@link NativeSingleViewAdapter} is NOT imported here; the coordinator is the
 * only native abstraction this backend touches.
 */

import { activatePane, type SplitTree } from "../../shared/split-tree";
import {
	NativeMultipaneCoordinator,
	defaultCoordinatorDeps,
	type CoordinatorDeps,
	type PaneCaptureSource,
	type PaneLaunchSpec,
	type PaneSnapshot,
} from "../native-terminal-multipane/coordinator";
import {
	CoordinatorExistsError,
	CoordinatorGoneError,
	LayoutPaneSetMismatchError,
	ObserverMutationError,
	PaneNotFoundError,
	PaneResizeNotAppliedError,
} from "../native-terminal-multipane/errors";
import {
	defineShellLaunchSpec,
	defaultNativeShellLaunchSpec,
	type ShellLaunchSpec,
} from "../native-terminal-registry/shell-launch";
import { snapshotCaptureLines } from "../native-terminal-adapter/view-reconstruction";
import {
	boundCaptureLines,
	lastChangeAge,
	captureIncarnation,
	clampHistoryLines,
	clampMaxBytes,
	knownFact,
	paneCaptureMiss,
	paneIdentityDrift,
	TERMINAL_CAPTURE_VERSION,
	unknownFact,
	type TerminalCaptureFact,
	type TerminalCaptureIssue,
	type TerminalPaneCapture,
	type TerminalPaneCaptureContent,
	type TerminalPaneCaptureGaps,
	type TerminalPaneCaptureIdentity,
	type TerminalPaneCaptureRequest,
	type TerminalPaneLiveness,
} from "./capture";
import {
	isTerminalLaunchSpec,
	isTerminalSessionId,
	isTerminalSize,
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
	TerminalBackendError,
	attachmentReleased,
	backendFailure,
	invalidLaunch,
	invalidSessionId,
	invalidSize,
	sessionExists,
	sessionNotFound,
	viewNotFound,
} from "./errors";

export interface NativeTerminalBackendOptions {
	/** Injectable coordinator seams — tests pass fakes, production uses the defaults. */
	deps?: Partial<CoordinatorDeps>;
}

/** Translate a coordinator failure into the contract's typed error. */
function translate(
	operation: string,
	err: unknown,
	sessionId: TerminalSessionId,
	viewId?: TerminalViewId,
): TerminalBackendError {
	if (err instanceof CoordinatorExistsError) return sessionExists(sessionId);
	if (err instanceof CoordinatorGoneError) return sessionNotFound(sessionId);
	if (err instanceof PaneNotFoundError) return viewNotFound(sessionId, viewId ?? err.paneId);
	if (
		err instanceof ObserverMutationError ||
		err instanceof PaneResizeNotAppliedError ||
		err instanceof LayoutPaneSetMismatchError
	) {
		return backendFailure(operation, err, { sessionId, viewId });
	}
	return backendFailure(operation, err, { sessionId, viewId });
}

function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Opaque identity for one pane: its host and shell processes hashed together
 * with the coordinator's epoch, so neither a pid nor a path leaves the seam.
 */
function captureIdentityOf(
	backend: "native",
	sessionId: TerminalSessionId,
	epoch: string,
	pane: PaneSnapshot,
): TerminalPaneCaptureIdentity {
	return {
		backend,
		sessionId,
		viewId: pane.paneId,
		// Pids alone would compare EQUAL after pid reuse under the same session id,
		// so the host's and shell's start signatures ride along — the same evidence
		// ownership classification trusts.
		incarnation: knownFact(
			captureIncarnation(
				pane.sessionId,
				pane.hostPid,
				pane.hostStartSignature,
				pane.shellPid,
				pane.shellStartSignature,
			),
		),
		epoch: knownFact(captureIncarnation(epoch)),
	};
}

/** One observation, whichever surface the pane's host publishes. */
interface PaneObservation {
	gaps: TerminalCaptureFact<TerminalPaneCaptureGaps>;
	updatedAt: string;
	activeBuffer: "normal" | "alternate";
	cols: number;
	rows: number;
	viewport: string[];
	history: string[];
	historyTotal: number;
	status: "live" | "overflowed" | "failed";
	error?: string;
}

function observationOf(source: Extract<PaneCaptureSource, { kind: "capture-record" | "snapshot" }>): PaneObservation {
	if (source.kind === "capture-record") {
		const record = source.record;
		return {
			updatedAt: record.updatedAt,
			activeBuffer: record.activeBuffer,
			cols: record.cols,
			rows: record.rows,
			viewport: record.viewport,
			history: record.history,
			historyTotal: record.historyTotal,
			status: record.health.status,
			...(record.health.error ? { error: record.health.error } : {}),
			gaps: knownFact({
				droppedBytes: record.health.droppedBytes,
				droppedChunks: record.health.droppedChunks,
				resyncGaps: record.health.resyncGaps,
				degraded: record.health.status !== "live",
			}),
		};
	}
	const { snapshot, state } = source;
	const lines = snapshotCaptureLines(state);
	return {
		updatedAt: snapshot.updatedAt,
		activeBuffer: state.activeBuffer,
		cols: state.dimensions.cols,
		rows: state.dimensions.rows,
		viewport: lines.viewport,
		history: lines.history,
		historyTotal: state.scrollbackLength,
		status: snapshot.health.status,
		...(snapshot.health.error ? { error: snapshot.health.error } : {}),
		// The per-cell artifact does not carry resync accounting at all, so its loss
		// evidence is INCOMPLETE. Reporting a zero here would be the fake zero this
		// contract exists to forbid, so the whole fact is unknown.
		gaps: unknownFact(
			"the per-cell snapshot carries no resync accounting, so output loss cannot be established from it",
		),
	};
}

function buildLaunchSpec(spec: TerminalSessionSpec | TerminalViewSpec): ShellLaunchSpec {
	const cwd = spec.cwd;
	const env = (spec.env as Record<string, string> | undefined) ?? {};
	if (spec.launch) {
		if (!isTerminalLaunchSpec(spec.launch)) throw invalidLaunch(spec.launch);
		return defineShellLaunchSpec({
			executable: spec.launch.executable,
			argv: [...spec.launch.argv],
			cwd,
			env,
		});
	}
	if (spec.command?.trim()) {
		return defineShellLaunchSpec({ executable: spec.command, argv: [], cwd, env });
	}
	const defaults = defaultNativeShellLaunchSpec({ platform: process.platform, cwd, env: process.env });
	return defineShellLaunchSpec({ ...defaults, env });
}

export class NativeTerminalBackend implements TerminalBackend {
	readonly kind = "native" as const;
	private readonly deps: CoordinatorDeps;
	private readonly coordinators = new Map<TerminalSessionId, NativeMultipaneCoordinator>();
	private readonly attachments = new Set<NativeMultipaneAttachment>();

	constructor(options: NativeTerminalBackendOptions = {}) {
		this.deps = { ...defaultCoordinatorDeps, ...options.deps };
	}

	async openSession(spec: TerminalSessionSpec): Promise<TerminalSessionState> {
		if (!isTerminalSessionId(spec.id)) throw invalidSessionId(spec.id);
		if (spec.size && !isTerminalSize(spec.size)) throw invalidSize(spec.size);
		if (spec.launch && !isTerminalLaunchSpec(spec.launch)) throw invalidLaunch(spec.launch);
		if (await this.describeSession(spec.id)) throw sessionExists(spec.id);

		let paneSpec: PaneLaunchSpec;
		try {
			paneSpec = {
				launch: buildLaunchSpec(spec),
				cols: spec.size?.cols,
				rows: spec.size?.rows,
			};
		} catch (err) {
			if (err instanceof TerminalBackendError) throw err;
			throw backendFailure("openSession", err, { sessionId: spec.id });
		}

		const coordinator = await this.guard("openSession", spec.id, () =>
			NativeMultipaneCoordinator.create(spec.id, paneSpec, this.deps),
		);
		this.coordinators.set(spec.id, coordinator);
		return this.toSessionState(spec.id, coordinator);
	}

	async describeSession(id: TerminalSessionId): Promise<TerminalSessionState | null> {
		if (!isTerminalSessionId(id)) return null;
		try {
			// Always recover from disk so dead panes (reconciled out by recover()) are
			// reflected immediately — a cached coordinator would miss pane deaths.
			const coordinator = await NativeMultipaneCoordinator.recover(id, this.deps);
			if (coordinator) {
				this.coordinators.set(id, coordinator);
				return this.toSessionState(id, coordinator);
			}
			this.coordinators.delete(id);
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Read-only, and it does NOT connect. The pane's host publishes its bounded
	 * parser snapshot whether or not a client is attached, so a capture is a file
	 * read: no writer lease, no protocol message, no WebSocket for an idle observer,
	 * and nothing the pane's agent has to cooperate with.
	 *
	 * The snapshot is persisted on a cadence (decision 169), so `sourceUpdatedAt`
	 * legitimately trails `readAt`. That gap is reported as `lastChangeAgeMs` and
	 * never hidden — but it is NOT staleness: a quiet pane's snapshot is old and its
	 * screen is correct, so `freshness` stays unknown until a producer heartbeat
	 * exists to prove otherwise.
	 *
	 * TODAY, in production, this returns `not-enabled` for every native pane: the
	 * host's live parser is off by default, so there is no snapshot to read. That is
	 * the honest answer, not a placeholder — see decision 202.
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
			epoch: unknownFact("the pane set was not observed"),
		};
		if (!isTerminalSessionId(id)) {
			return paneCaptureMiss(blind, "session-absent", `session id ${JSON.stringify(id)} is not portable`);
		}

		// EVERY outcome, miss or not, is bracketed by the same two identity checks, so
		// a pane replaced during a miss is reported as replaced rather than as whatever
		// the miss happened to be.
		const bracket = async <T extends TerminalPaneCapture>(
			identity: TerminalPaneCaptureIdentity,
			liveness: TerminalPaneLiveness,
			outcome: () => T | Promise<T>,
		): Promise<TerminalPaneCapture> => {
			const result = await outcome();
			let after: Awaited<ReturnType<typeof this.inspectPaneSet>>;
			try {
				after = await this.inspectPaneSet(id);
			} catch (err) {
				return paneCaptureMiss(identity, "unreadable", `the pane set could not be re-read: ${reasonOf(err)}`, liveness);
			}
			if (!after) return result;
			const afterPane = after.panes.find((entry) => entry.paneId === viewId);
			if (!afterPane) return result;
			const drift = paneIdentityDrift(identity, captureIdentityOf(this.kind, id, after.epoch, afterPane));
			return drift
				? paneCaptureMiss(identity, "replaced", `the pane was replaced mid-capture: ${drift}`, liveness)
				: result;
		};

		// Purely observational: this inspection probes ownership and reads state, and
		// it never stops a pane, rewrites the coordinator record, or reconciles the
		// layout. A read that mutates runtime or persisted membership is not a read.
		let before: Awaited<ReturnType<typeof this.inspectPaneSet>>;
		try {
			before = await this.inspectPaneSet(id);
		} catch (err) {
			// A session whose state exists but cannot be believed is unreadable. Only a
			// successfully observed absence may be reported as absent.
			return paneCaptureMiss(blind, "unreadable", `the pane set could not be read: ${reasonOf(err)}`);
		}
		if (!before) {
			return paneCaptureMiss(blind, "session-absent", `no native session ${JSON.stringify(id)} is owned by this app`);
		}
		const pane = before.panes.find((entry) => entry.paneId === viewId);
		if (!pane) {
			return paneCaptureMiss(blind, "view-absent", `pane ${JSON.stringify(viewId)} is not part of the session`);
		}

		const identity = captureIdentityOf(this.kind, id, before.epoch, pane);
		const liveness: TerminalPaneLiveness = pane.state === "dead" ? "dead" : "live";
		return bracket(identity, liveness, async () => {
			let source: PaneCaptureSource;
			try {
				source = this.captureSourceOf(id, viewId);
			} catch (err) {
				return paneCaptureMiss(identity, "unreadable", `the pane's capture source failed: ${reasonOf(err)}`, liveness);
			}
			if (source.kind === "disabled") return paneCaptureMiss(identity, "not-enabled", source.reason, liveness);
			if (source.kind === "unreadable") return paneCaptureMiss(identity, "unreadable", source.reason, liveness);
			if (source.kind === "empty") return paneCaptureMiss(identity, "unavailable", source.reason, liveness);

			// The compact record names its own producer, so its rows are checked against
			// the pane directly — text written by a previous incarnation is caught even
			// when both ownership observations agree.
			if (source.kind === "capture-record") {
				const producer = source.record.producer;
				const wrote = captureIncarnation(
					source.record.sessionId,
					producer.hostPid,
					producer.hostStartSignature,
					producer.shellPid,
					producer.shellStartSignature,
				);
				if (identity.incarnation.known && identity.incarnation.value !== wrote) {
					return paneCaptureMiss(
						identity,
						"replaced",
						"the capture record was written by a different incarnation of this pane",
						liveness,
					);
				}
			}

			const readAt = new Date().toISOString();
			// Both surfaces reduce to the same observation, so no consumer branches on
			// which artifact a host happens to publish.
			const observed = observationOf(source);
			const alternate = observed.activeBuffer === "alternate";
			const bounded = boundCaptureLines(
				{
					viewport: observed.viewport,
					history: alternate ? [] : observed.history,
					historyAvailable: alternate ? 0 : observed.historyTotal,
				},
				{ historyLines: clampHistoryLines(request.historyLines), maxBytes: clampMaxBytes(request.maxBytes) },
			);
			const sourceUpdatedAt = knownFact(observed.updatedAt);
			const issues: TerminalCaptureIssue[] = [...bounded.issues];
			if (observed.gaps.known) {
				const gaps = observed.gaps.value;
				if (gaps.droppedChunks > 0 || gaps.droppedBytes > 0 || gaps.resyncGaps > 0) {
					issues.push({
						code: "sequence-gap",
						detail:
							`the pane's parser dropped ${gaps.droppedBytes} byte(s) in ${gaps.droppedChunks} chunk(s) ` +
							`and resynced across ${gaps.resyncGaps} gap(s) before this capture`,
					});
				}
			} else {
				issues.push({ code: "unknown", detail: observed.gaps.reason });
			}
			if (observed.status !== "live") {
				issues.push({
					code: "parser-failed",
					detail: observed.error ?? `the pane's parser is ${observed.status}`,
				});
			}
			return {
				version: TERMINAL_CAPTURE_VERSION,
				identity,
				readAt,
				availability: "captured",
				sourceUpdatedAt,
				lastChangeAgeMs: lastChangeAge(sourceUpdatedAt, readAt),
				// The producer publishes on change and offers no heartbeat, so a quiet pane
				// and a wedged parser look identical from here. Unknown is the only honest
				// answer; an age threshold would call every idle pane stale.
				freshness: unknownFact(
					"the pane's producer publishes on change and offers no heartbeat, so currency cannot be established",
				),
				liveness,
				size: knownFact({ cols: observed.cols, rows: observed.rows }),
				screen: knownFact(alternate ? "alternate" : "normal"),
				content: bounded.content,
				bounds: bounded.bounds,
				gaps: observed.gaps,
				issues,
			} satisfies TerminalPaneCaptureContent;
		});
	}

	/**
	 * The pane set as OBSERVED: same probes as recovery, none of its consequences.
	 * Recovery may stop panes and rewrite the coordinator record; a capture may not.
	 */
	private async inspectPaneSet(
		id: TerminalSessionId,
	): Promise<{ epoch: string; panes: PaneSnapshot[] } | null> {
		if (!isTerminalSessionId(id)) return null;
		return NativeMultipaneCoordinator.inspectPaneSet(id, this.deps);
	}

	/** Read one pane's capture source without constructing a reconciling controller. */
	private captureSourceOf(id: TerminalSessionId, viewId: TerminalViewId): PaneCaptureSource {
		return NativeMultipaneCoordinator.inspectPaneCaptureSource(id, viewId, this.deps);
	}

	async attachView(id: TerminalSessionId, viewId?: TerminalViewId): Promise<TerminalAttachment> {
		const state = await this.requireSession(id);
		const target = viewId ?? state.focusedViewId ?? state.views[0]?.id;
		if (!target) throw viewNotFound(id, viewId ?? "<focused>");
		if (!state.views.some((v) => v.id === target)) throw viewNotFound(id, target);
		const coordinator = await this.requireCoordinator(id);
		const attachment = new NativeMultipaneAttachment(id, target, coordinator, (released) =>
			this.attachments.delete(released),
		);
		this.attachments.add(attachment);
		return attachment;
	}

	async focusView(id: TerminalSessionId, viewId: TerminalViewId): Promise<void> {
		const coordinator = await this.requireCoordinator(id);
		if (!coordinator.paneIds().includes(viewId)) throw viewNotFound(id, viewId);
		const newTree = activatePane(coordinator.layout, viewId);
		await this.guard("focusView", id, () => coordinator.publishGeometry(newTree), viewId);
	}

	async splitView(
		id: TerminalSessionId,
		from: TerminalViewId,
		spec: TerminalViewSpec,
	): Promise<TerminalViewState> {
		const coordinator = await this.requireCoordinator(id);
		if (!coordinator.paneIds().includes(from)) throw viewNotFound(id, from);

		let paneSpec: PaneLaunchSpec;
		try {
			paneSpec = { launch: buildLaunchSpec(spec) };
		} catch (err) {
			if (err instanceof TerminalBackendError) throw err;
			throw backendFailure("splitView", err, { sessionId: id });
		}

		const orientation = spec.orientation ?? "horizontal";
		const newPaneId = await this.guard("splitView", id, () =>
			coordinator.split(from, orientation, paneSpec),
		);
		return { id: newPaneId, focused: coordinator.layout.activePaneId === newPaneId };
	}

	async closeView(
		id: TerminalSessionId,
		viewId: TerminalViewId,
		opts: TerminalTeardownOptions = {},
	): Promise<void> {
		const ignoreMissing = opts.ignoreMissing ?? false;
		const coordinator = await this.getOrRecover(id);
		if (!coordinator) {
			if (ignoreMissing) return;
			throw sessionNotFound(id);
		}
		if (!coordinator.paneIds().includes(viewId)) {
			if (ignoreMissing) return;
			throw viewNotFound(id, viewId);
		}
		const result = await this.guard("closeView", id, () => coordinator.closePane(viewId), viewId);
		if (result.sessionTornDown) this.coordinators.delete(id);
	}

	async cleanupSession(id: TerminalSessionId, opts: TerminalTeardownOptions = {}): Promise<void> {
		const ignoreMissing = opts.ignoreMissing ?? false;
		for (const att of [...this.attachments]) {
			if (att.sessionId === id) await att.detach();
		}
		const coordinator = await this.getOrRecover(id);
		if (!coordinator) {
			if (ignoreMissing) return;
			throw sessionNotFound(id);
		}
		await this.guard("cleanupSession", id, () => coordinator.cleanup());
		this.coordinators.delete(id);
	}

	// ── Native-only methods (not on TerminalBackend; callers hold the concrete type) ──

	/**
	 * The whole pane set from ONE ownership sweep: per-pane snapshots and the
	 * layout they were proved against. `describeSession` + `listPanes` answers the
	 * same question with two sweeps, i.e. four `ps` probes per pane (seq 1388).
	 * Returns `null` on the same condition as `describeSession`: no pane survives.
	 */
	async readPaneSet(id: TerminalSessionId): Promise<{ panes: PaneSnapshot[]; layout: SplitTree } | null> {
		try {
			// Tolerant about the READ, not about ownership: a failed read reports "no pane
			// set" rather than throwing, while recovery still keeps a pane it cannot
			// identify — hidden from the snapshot, untouched on disk.
			return await this.recoverPaneSetInto(id, false);
		} catch {
			return null;
		}
	}

	/**
	 * {@link readPaneSet} for a caller that is about to replace a pane. One thing
	 * changes: nothing is swallowed. An unreadable record or a pane whose owner cannot
	 * be established throws, instead of being reported as an empty set — the answer a
	 * replacement must never act on. `null` still means recovery RAN and no pane
	 * survived, which is a real answer.
	 */
	async readPaneSetStrict(id: TerminalSessionId): Promise<{ panes: PaneSnapshot[]; layout: SplitTree } | null> {
		return this.recoverPaneSetInto(id, true);
	}

	private async recoverPaneSetInto(
		id: TerminalSessionId,
		strict: boolean,
	): Promise<{ panes: PaneSnapshot[]; layout: SplitTree } | null> {
		if (!isTerminalSessionId(id)) return null;
		const recovered = await NativeMultipaneCoordinator.recoverPaneSet(id, this.deps, { strict });
		if (!recovered) {
			this.coordinators.delete(id);
			return null;
		}
		this.coordinators.set(id, recovered.coordinator);
		return { panes: recovered.panes, layout: recovered.coordinator.layout };
	}

	/** Per-pane host/shell pids, size, and liveness — not expressible via the contract. */
	async listPanes(id: TerminalSessionId): Promise<PaneSnapshot[] | null> {
		const coordinator = await this.getOrRecover(id);
		if (!coordinator) return null;
		return coordinator.listPanes();
	}

	/** The shared SplitTree (membership + geometry) of a session's coordinator. */
	async paneLayout(id: TerminalSessionId): Promise<SplitTree | null> {
		const coordinator = await this.getOrRecover(id);
		if (!coordinator) return null;
		return coordinator.layout;
	}

	/** Type into one pane without attaching a view (agent hand-off prompts). */
	async writePane(id: TerminalSessionId, viewId: TerminalViewId, data: string): Promise<void> {
		const coordinator = await this.getOrRecover(id);
		if (!coordinator) throw sessionNotFound(id);
		await this.guard("writePane", id, () => coordinator.writePane(viewId, data));
	}

	/** Publish a geometry-only layout change via the coordinator. */
	async publishPaneGeometry(id: TerminalSessionId, tree: SplitTree): Promise<void> {
		const coordinator = await this.getOrRecover(id);
		if (!coordinator) throw sessionNotFound(id);
		await this.guard("publishPaneGeometry", id, () => coordinator.publishGeometry(tree));
	}

	async dispose(): Promise<void> {
		for (const att of [...this.attachments]) await att.detach();
		this.attachments.clear();
		this.coordinators.clear();
	}

	private async getOrRecover(id: TerminalSessionId): Promise<NativeMultipaneCoordinator | null> {
		const cached = this.coordinators.get(id);
		if (cached) return cached;
		const recovered = await NativeMultipaneCoordinator.recover(id, this.deps);
		if (recovered) this.coordinators.set(id, recovered);
		return recovered;
	}

	private async requireCoordinator(id: TerminalSessionId): Promise<NativeMultipaneCoordinator> {
		const c = await this.getOrRecover(id);
		if (!c) throw sessionNotFound(id);
		return c;
	}

	private async requireSession(id: TerminalSessionId): Promise<TerminalSessionState> {
		const state = await this.describeSession(id);
		if (!state) throw sessionNotFound(id);
		return state;
	}

	private toSessionState(
		id: TerminalSessionId,
		coordinator: NativeMultipaneCoordinator,
	): TerminalSessionState {
		const paneIds = coordinator.paneIds();
		const activePaneId = coordinator.layout.activePaneId;
		const views: TerminalViewState[] = paneIds.map((paneId) => ({
			id: paneId,
			focused: paneId === activePaneId,
		}));
		return { id, views, focusedViewId: activePaneId ?? null };
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

class NativeMultipaneAttachment implements TerminalAttachment {
	private released = false;

	constructor(
		readonly sessionId: TerminalSessionId,
		readonly viewId: TerminalViewId,
		private readonly coordinator: NativeMultipaneCoordinator,
		private readonly onDetach: (attachment: NativeMultipaneAttachment) => void,
	) {}

	write(data: string): Promise<void> {
		return this.run("write", () => this.coordinator.writePane(this.viewId, data));
	}

	resize(size: TerminalSize): Promise<void> {
		if (!isTerminalSize(size)) return Promise.reject(invalidSize(size));
		return this.run("resize", () =>
			this.coordinator.resizePane(this.viewId, size.cols, size.rows),
		);
	}

	async detach(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.onDetach(this);
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
