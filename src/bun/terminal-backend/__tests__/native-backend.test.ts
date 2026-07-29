/**
 * Native-backend specifics the shared conformance suite cannot express:
 * coordinator-backed multi-view split, focus, the error mapping, and
 * the isolation invariant (no NativeSingleViewAdapter in scope).
 */

import { afterEach, describe, expect, it } from "vitest";
import { NativeTerminalBackend } from "../native-backend";
import { TerminalBackendError } from "../errors";
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
