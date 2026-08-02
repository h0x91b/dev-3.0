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
			return await this.readPaneSetStrict(id);
		} catch {
			return null;
		}
	}

	/**
	 * {@link readPaneSet} without the catch: `null` means recovery RAN and found no
	 * surviving pane, while a throw means it could not tell. Callers that are about
	 * to replace a pane need that difference — treating "could not read" as "nothing
	 * there" is how a second agent gets opened beside a live one.
	 */
	async readPaneSetStrict(id: TerminalSessionId): Promise<{ panes: PaneSnapshot[]; layout: SplitTree } | null> {
		if (!isTerminalSessionId(id)) return null;
		const recovered = await NativeMultipaneCoordinator.recoverPaneSet(id, this.deps);
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

	async capture(opts: TerminalCaptureOptions = {}): Promise<TerminalCapture> {
		const text = await this.run("capture", () =>
			this.coordinator.capturePane(this.viewId, opts.includeScrollback ?? false),
		);
		return { viewId: this.viewId, text };
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
