/**
 * Native-backend specifics the shared conformance suite cannot express:
 * coordinator-backed multi-view split, focus, the error mapping, and
 * the isolation invariant (no NativeSingleViewAdapter in scope).
 */

import { afterEach, describe, expect, it } from "vitest";
import { NativeTerminalBackend } from "../native-backend";
import { TerminalBackendError } from "../errors";
import {
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY,
} from "../../native-terminal-registry/record";
import { existsSync, readFileSync, statSync } from "node:fs";
import { coordinatorRecordFile } from "../../native-terminal-multipane/paths";
import { FakeCoordinatorWorld } from "./fake-coordinator-world";

const SESSION = "task-native";
const CWD = "/tmp/dev3-native";

function harness() {
	const world = new FakeCoordinatorWorld();
	return { world, backend: new NativeTerminalBackend({ deps: world.deps() }) };
}

describe("NativeTerminalBackend", () => {
	let world: FakeCoordinatorWorld | null = null;

	afterEach(() => {
		world?.cleanup();
		world = null;
	});

	it("reports the native backend kind", () => {
		const h = harness();
		world = h.world;
		expect(h.backend.kind).toBe("native");
	});

	it("opens a session with one focused view", async () => {
		const h = harness();
		world = h.world;
		const state = await h.backend.openSession({ id: SESSION, cwd: CWD });
		expect(state.views).toHaveLength(1);
		expect(state.views[0].focused).toBe(true);
	});

	it("describes the session with the same ids it reported at creation", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		await expect(h.backend.describeSession(SESSION)).resolves.toEqual(created);
	});

	it("splits the session into two views", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const first = created.views[0].id;
		const second = await h.backend.splitView(SESSION, first, { cwd: CWD });
		expect(second.id).not.toBe(first);
		const state = await h.backend.describeSession(SESSION);
		expect(state?.views).toHaveLength(2);
	});

	it("focuses a second view by publishing a geometry change", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const first = created.views[0].id;
		const second = await h.backend.splitView(SESSION, first, { cwd: CWD });
		await h.backend.focusView(SESSION, second.id);
		const state = await h.backend.describeSession(SESSION);
		expect(state?.focusedViewId).toBe(second.id);
	});

	it("closes one view without tearing the session down", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const first = created.views[0].id;
		const second = await h.backend.splitView(SESSION, first, { cwd: CWD });
		await h.backend.closeView(SESSION, second.id);
		const state = await h.backend.describeSession(SESSION);
		expect(state?.views).toHaveLength(1);
		expect(state?.views[0].id).toBe(first);
	});

	it("tears the session down when the last view is closed", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		await h.backend.closeView(SESSION, created.views[0].id);
		await expect(h.backend.describeSession(SESSION)).resolves.toBeNull();
	});

	it("wraps an unexpected coordinator failure as backend-failure with its cause", async () => {
		const h = harness();
		world = h.world;
		// Break startPane so openSession fails with an unexpected error.
		const boom = new Error("host refused to start");
		const brokenDeps = { ...h.world.deps(), startPane: async () => { throw boom; } };
		const backend = new NativeTerminalBackend({ deps: brokenDeps });
		const err = await backend.openSession({ id: SESSION, cwd: CWD }).catch((e) => e);
		expect(err).toBeInstanceOf(TerminalBackendError);
		expect(err.code).toBe("backend-failure");
		expect(err.cause).toBe(boom);
	});

	it("listPanes returns per-pane pids via the native-only method", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD, size: { cols: 100, rows: 30 } });
		const panes = await h.backend.listPanes(SESSION);
		expect(panes).not.toBeNull();
		expect(panes!).toHaveLength(created.views.length);
		expect(panes![0].paneId).toBe(created.views[0].id);
		expect(panes![0].cols).toBe(100);
		expect(panes![0].rows).toBe(30);
	});

	it("paneLayout returns the shared SplitTree", async () => {
		const h = harness();
		world = h.world;
		await h.backend.openSession({ id: SESSION, cwd: CWD });
		const layout = await h.backend.paneLayout(SESSION);
		expect(layout).not.toBeNull();
		expect(layout!.activePaneId).toBeDefined();
	});

	it("publishPaneGeometry changes the shared activePaneId", async () => {
		const h = harness();
		world = h.world;
		await h.backend.openSession({ id: SESSION, cwd: CWD });
		await h.backend.splitView(SESSION, (await h.backend.describeSession(SESSION))!.views[0].id, { cwd: CWD });
		const layout = await h.backend.paneLayout(SESSION);
		const panes = await h.backend.describeSession(SESSION);
		const secondPane = panes!.views[1]!.id;
		// Activate second pane via geometry publish.
		await h.backend.publishPaneGeometry(SESSION, { ...layout!, activePaneId: secondPane });
		const updated = await h.backend.paneLayout(SESSION);
		expect(updated!.activePaneId).toBe(secondPane);
	});

	it("releases its attachments on dispose without stopping the session", async () => {
		const h = harness();
		world = h.world;
		await h.backend.openSession({ id: SESSION, cwd: CWD });
		await h.backend.dispose();
		// Session still alive (persistent across dispose).
		const fresh = new NativeTerminalBackend({ deps: h.world.deps() });
		await expect(fresh.describeSession(SESSION)).resolves.not.toBeNull();
	});

	it("treats a record owned by another instance as absent", async () => {
		const h = harness();
		world = h.world;
		await h.backend.openSession({ id: SESSION, cwd: CWD });
		// Kill all panes so the coordinator record appears dead.
		for (const pane of h.world.registry.panes.keys()) {
			h.world.registry.kill(pane);
		}
		await expect(h.backend.describeSession(SESSION)).resolves.toBeNull();
	});
});

// ── Read-only capture ──────────────────────────────────────────────

describe("NativeTerminalBackend read-only capture", () => {
	let world: FakeCoordinatorWorld | null = null;

	afterEach(() => {
		world?.cleanup();
		world = null;
	});

	/** The pane's own registry session id — how the fake keys its panes. */
	function paneOf(w: FakeCoordinatorWorld, viewId: string) {
		const pane = w.registry.panes.get(`${SESSION}-${viewId}`);
		if (!pane) throw new Error(`fake pane ${viewId} missing`);
		return pane;
	}

	it("sources content from the parser snapshot without ever connecting", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		await h.backend.writePane(SESSION, view, "native-capture\r");

		const before = world.registry.panes.get(`${SESSION}-${view}`)?.writerTaken;
		const capture = await h.backend.captureView(SESSION, view);
		if (capture.availability !== "captured") throw new Error(capture.reason);
		expect(capture.content.viewport.join("\n")).toContain("native-capture");
		// Capturing takes no writer lease and opens no new client.
		expect(world.registry.panes.get(`${SESSION}-${view}`)?.writerTaken).toBe(before);
		// The snapshot carries its own timestamp, kept separate from the read.
		expect(capture.sourceUpdatedAt.known).toBe(true);
		expect(capture.lastChangeAgeMs.known).toBe(true);
		// A change-driven producer with no heartbeat cannot vouch for currency, and
		// must not pretend to by turning age into a verdict.
		expect(capture.freshness.known).toBe(false);
		expect(capture.identity.epoch.known).toBe(true);
	});

	it("reports a host with no capture capability as not-enabled, which is production today", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		const pane = paneOf(world, view);
		// Exactly what an old record or a parser-less host looks like on disk.
		delete pane.record.capabilities;
		pane.parserState = "absent";

		const capture = await h.backend.captureView(SESSION, view);
		expect(capture.availability).toBe("not-enabled");
		if (capture.availability === "captured") throw new Error("must not carry content");
		expect(capture.reason).toContain("no live parser");
		// A miss still identifies the pane it missed on, and reports it alive.
		expect(capture.identity.incarnation.known).toBe(true);
		expect(capture.liveness).toBe("live");
	});

	it("reports a capable host that has not published yet as unavailable, not as incapable", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		// Capability advertised, first snapshot not written: come back later.
		paneOf(world, view).parserState = "absent";

		const capture = await h.backend.captureView(SESSION, view);
		expect(capture.availability).toBe("unavailable");
	});

	it("does not compare equal after pid reuse, because start signatures ride along", async () => {
		const w = new FakeCoordinatorWorld();
		world = w;
		const backend = new NativeTerminalBackend({ deps: w.deps() });
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		const first = await backend.captureView(SESSION, view);

		// A brand-new shell that happens to land on the SAME pid — pids alone would
		// call this the same pane, which is exactly the mistake to prevent.
		const pane = paneOf(w, view);
		pane.record.shell.startSignature = "shell-restarted";
		const second = await backend.captureView(SESSION, view);

		expect(first.identity.incarnation.known && second.identity.incarnation.known).toBe(true);
		if (!first.identity.incarnation.known || !second.identity.incarnation.known) return;
		expect(second.identity.incarnation.value).not.toBe(first.identity.incarnation.value);
	});

	it("reports an unbelievable snapshot as unreadable rather than as a blank screen", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		paneOf(world, view).parserState = "rejected";

		const capture = await h.backend.captureView(SESSION, view);
		expect(capture.availability).toBe("unreadable");
	});

	it("refuses to invent zero gaps for the per-cell surface, which cannot prove them", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		paneOf(world, view).droppedBytes = 4096;

		const capture = await h.backend.captureView(SESSION, view);
		if (capture.availability !== "captured") throw new Error(capture.reason);
		// The per-cell artifact carries no resync accounting, so its loss evidence is
		// incomplete — and incomplete evidence is unknown, never a reassuring zero.
		expect(capture.gaps.known).toBe(false);
		if (capture.gaps.known) return;
		expect(capture.gaps.reason).toContain("resync");
		expect(capture.issues.some((issue) => issue.code === "unknown")).toBe(true);
	});

	it("reports a pane replaced mid-capture instead of returning its successor's screen", async () => {
		const w = new FakeCoordinatorWorld();
		world = w;
		// The swap has to be armed BEFORE the backend copies its deps, then triggered
		// only once the pane exists: a pane replaced exactly while its snapshot is read.
		const inspect = w.registry.inspectPaneParserState!.bind(w.registry);
		let armed = false;
		w.registry.inspectPaneParserState = (sessionId) => {
			const result = inspect(sessionId);
			if (armed) {
				const pane = w.registry.panes.get(sessionId);
				if (pane) pane.record.shell.pid += 1;
			}
			return result;
		};
		const backend = new NativeTerminalBackend({ deps: w.deps() });
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		armed = true;

		const capture = await backend.captureView(SESSION, view);
		expect(capture.availability).toBe("replaced");
		if (capture.availability === "captured") throw new Error("must not carry content");
		expect(capture.reason).toContain("incarnation changed");
	});
});

// ── The compact plain-text capture surface ─────────────────

describe("NativeTerminalBackend capture over the compact surface", () => {
	let world: FakeCoordinatorWorld | null = null;

	afterEach(() => {
		world?.cleanup();
		world = null;
	});

	/**
	 * A pane whose host advertises the cheap plain-text surface. `patch` runs
	 * BEFORE the backend copies its deps — a later reassignment would be invisible.
	 */
	async function textSurfaceHarness(patch?: (registry: FakeCoordinatorWorld["registry"]) => void) {
		const w = new FakeCoordinatorWorld();
		world = w;
		patch?.(w.registry);
		const backend = new NativeTerminalBackend({ deps: w.deps() });
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		const pane = w.registry.panes.get(`${SESSION}-${view}`);
		if (!pane) throw new Error("fake pane missing");
		pane.record.capabilities = { capture: [NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY] };
		return { w, backend, view, pane };
	}

	it("captures from the compact record, and never reads the per-cell snapshot", async () => {
		let snapshotReads = 0;
		const { backend, view } = await textSurfaceHarness((registry) => {
			const inner = registry.inspectPaneParserState!.bind(registry);
			registry.inspectPaneParserState = (sessionId) => {
				snapshotReads++;
				return inner(sessionId);
			};
		});
		await backend.writePane(SESSION, view, "compact-surface\r");

		const capture = await backend.captureView(SESSION, view, { historyLines: 10 });
		if (capture.availability !== "captured") throw new Error(capture.reason);
		expect(capture.content.viewport.join("\n")).toContain("compact-surface");
		expect(capture.content.lineModel).toBe("physical-rows");
		expect(capture.size.known).toBe(true);
		// The expensive surface is not touched at all — that is the whole point.
		expect(snapshotReads).toBe(0);
	});

	it("answers identically on both surfaces for the same pane", async () => {
		const { backend, view, pane } = await textSurfaceHarness();
		await backend.writePane(SESSION, view, "same-answer\r");
		const compact = await backend.captureView(SESSION, view, { historyLines: 10 });
		pane.record.capabilities = { capture: [NATIVE_SESSION_CAPTURE_CAPABILITY] };
		const perCell = await backend.captureView(SESSION, view, { historyLines: 10 });
		if (compact.availability !== "captured" || perCell.availability !== "captured") {
			throw new Error("both surfaces must carry content");
		}
		expect(compact.content.viewport).toEqual(perCell.content.viewport);
		expect(compact.content.history).toEqual(perCell.content.history);
		expect(compact.size).toEqual(perCell.size);
		expect(compact.screen).toEqual(perCell.screen);
	});

	it("reports a host that advertises the surface but has published nothing as unavailable", async () => {
		const { backend, view, pane } = await textSurfaceHarness();
		pane.parserState = "absent"; // no capture record on disk yet
		const capture = await backend.captureView(SESSION, view);
		expect(capture.availability).toBe("unavailable");
	});

	it("refuses a record written by a different incarnation of the pane", async () => {
		// The rows on disk came from the shell that ran BEFORE this one.
		const { backend, view, pane } = await textSurfaceHarness((registry) => {
			const inner = registry.inspectPaneCaptureRecord!.bind(registry);
			registry.inspectPaneCaptureRecord = (sessionId, digest) => {
				const inspection = inner(sessionId, digest);
				if (inspection.kind !== "present") return inspection;
				const record = inspection.record;
				return {
					kind: "present",
					record: { ...record, producer: { ...record.producer, shellStartSignature: "s-previous-life" } },
				};
			};
		});
		await backend.writePane(SESSION, view, "stale-writer\r");

		const capture = await backend.captureView(SESSION, view);
		expect(capture.availability).toBe("replaced");
		if (capture.availability === "captured") throw new Error("must not carry content");
		expect(capture.reason).toContain("different incarnation");
		expect(pane.record.shell.startSignature).not.toBe("s-previous-life");
	});

	it("reports the producer's dropped output and resync gaps from the compact record", async () => {
		const { backend, view } = await textSurfaceHarness((registry) => {
			const inner = registry.inspectPaneCaptureRecord!.bind(registry);
			registry.inspectPaneCaptureRecord = (sessionId, digest) => {
				const inspection = inner(sessionId, digest);
				if (inspection.kind !== "present") return inspection;
				return {
					kind: "present",
					record: {
						...inspection.record,
						health: { status: "overflowed" as const, droppedBytes: 900, droppedChunks: 3, resyncGaps: 2 },
					},
				};
			};
		});

		const capture = await backend.captureView(SESSION, view);
		if (capture.availability !== "captured") throw new Error(capture.reason);
		expect(capture.gaps).toEqual({
			known: true,
			value: { droppedBytes: 900, droppedChunks: 3, resyncGaps: 2, degraded: true },
		});
		const codes = capture.issues.map((issue) => issue.code);
		expect(codes).toContain("sequence-gap");
		expect(codes).toContain("parser-failed");
	});
});

// ── Capturing must be purely observational ───────────────────────────────────

describe("NativeTerminalBackend capture mutates nothing", () => {
	let world: FakeCoordinatorWorld | null = null;

	afterEach(() => {
		world?.cleanup();
		world = null;
	});

	/** Bytes and mtime of the coordinator record, so a rewrite cannot hide. */
	function coordinatorState(coordinatorId: string): { bytes: string; mtimeMs: number } {
		const file = coordinatorRecordFile(coordinatorId);
		return { bytes: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };
	}

	it("starts and stops nothing, and leaves the coordinator record byte-identical", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const second = await h.backend.splitView(SESSION, created.views[0].id, { cwd: CWD });
		const before = coordinatorState(SESSION);
		h.world.registry.startCalls.length = 0;
		h.world.registry.stopCalls.length = 0;

		// Twice, because the identity bracket reads the pane set on both sides.
		await h.backend.captureView(SESSION, created.views[0].id, { historyLines: 20 });
		await h.backend.captureView(SESSION, second.id);

		expect(h.world.registry.startCalls).toEqual([]);
		expect(h.world.registry.stopCalls).toEqual([]);
		expect(coordinatorState(SESSION)).toEqual(before);
	});

	it("does not reconcile a DEAD pane out of the session, it reports it", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		const second = await h.backend.splitView(SESSION, created.views[0].id, { cwd: CWD });
		// Kill one pane behind the backend's back: recovery would stop it and rewrite
		// the record; a capture may do neither.
		h.world.killViewProcess(SESSION, second.id);
		const before = coordinatorState(SESSION);
		h.world.registry.startCalls.length = 0;
		h.world.registry.stopCalls.length = 0;

		const dead = await h.backend.captureView(SESSION, second.id);
		const alive = await h.backend.captureView(SESSION, created.views[0].id);

		expect(h.world.registry.stopCalls).toEqual([]);
		expect(h.world.registry.startCalls).toEqual([]);
		expect(coordinatorState(SESSION)).toEqual(before);
		// The dead pane is still addressable and reported as dead, not as absent.
		expect(dead.liveness).toBe("dead");
		expect(alive.availability).not.toBe("session-absent");
	});

	it("does not remove the coordinator record when EVERY pane is dead", async () => {
		const h = harness();
		world = h.world;
		const created = await h.backend.openSession({ id: SESSION, cwd: CWD });
		h.world.killViewProcess(SESSION, created.views[0].id);
		const before = coordinatorState(SESSION);

		const capture = await h.backend.captureView(SESSION, created.views[0].id);

		// Recovery would have dropped the pane and deleted the record here.
		expect(existsSync(coordinatorRecordFile(SESSION))).toBe(true);
		expect(coordinatorState(SESSION)).toEqual(before);
		expect(h.world.registry.stopCalls).toEqual([]);
		expect(capture.liveness).toBe("dead");
	});
});

describe("NativeTerminalBackend identity bracket on every outcome", () => {
	let world: FakeCoordinatorWorld | null = null;

	afterEach(() => {
		world?.cleanup();
		world = null;
	});

	/**
	 * A pane replaced DURING the read, for each miss class. Every one of them must
	 * report `replaced` rather than the miss it would otherwise have been.
	 */
	const MISS_CLASSES: Array<{ name: string; parserState: "absent" | "rejected"; capability: boolean }> = [
		{ name: "not-enabled", parserState: "absent", capability: false },
		{ name: "unavailable", parserState: "absent", capability: true },
		{ name: "unreadable", parserState: "rejected", capability: true },
	];

	it.each(MISS_CLASSES)("reports replacement during a $name miss as replaced", async (miss) => {
		const w = new FakeCoordinatorWorld();
		world = w;
		let armed = false;
		const innerRecord = w.registry.readPaneRecord.bind(w.registry);
		w.registry.readPaneRecord = (sessionId) => {
			const record = innerRecord(sessionId);
			if (armed && record) {
				// The pane's shell is replaced between the two identity observations.
				record.shell.startSignature = `s-${Math.random()}`;
			}
			return record;
		};
		const backend = new NativeTerminalBackend({ deps: w.deps() });
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		const pane = w.registry.panes.get(`${SESSION}-${view}`);
		if (!pane) throw new Error("fake pane missing");
		pane.parserState = miss.parserState;
		if (!miss.capability) delete pane.record.capabilities;
		armed = true;

		const capture = await backend.captureView(SESSION, view);
		expect(capture.availability).toBe("replaced");
	});

	it("reports a pane set that cannot be believed as unreadable, never as session-absent", async () => {
		const w = new FakeCoordinatorWorld();
		world = w;
		// Armed AFTER the session exists, so the failure is a read failure over real
		// state rather than a missing session.
		let armed = false;
		const inner = w.registry.classifyPane.bind(w.registry);
		w.registry.classifyPane = (record, token) =>
			armed ? Promise.reject(new Error("ps exploded")) : inner(record, token);
		const backend = new NativeTerminalBackend({ deps: w.deps() });
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		armed = true;

		const capture = await backend.captureView(SESSION, created.views[0].id);
		expect(capture.availability).toBe("unreadable");
		if (capture.availability === "captured") throw new Error("must not carry content");
		expect(capture.reason).toContain("ps exploded");
	});
});
