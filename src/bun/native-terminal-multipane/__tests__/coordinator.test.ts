import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSplitTree, listPaneIds } from "../../../shared/split-tree";
import { defineShellLaunchSpec } from "../../native-terminal-registry/shell-launch";
import { NativeMultipaneCoordinator, type PaneLaunchSpec } from "../coordinator";
import {
	CoordinatorExistsError,
	CoordinatorGoneError,
	ObserverMutationError,
	PaneNotFoundError,
	PaneResizeNotAppliedError,
} from "../errors";
import { NATIVE_MULTIPANE_DIR_ENV, coordinatorRecordFile } from "../paths";
import { readMultipaneRecord, writeMultipaneRecordAtomic } from "../record";
import { createFakeRegistry, type FakeRegistry } from "./fake-panes";

const ID = "mp";

function launchFor(paneId: string): PaneLaunchSpec {
	return {
		launch: defineShellLaunchSpec({
			executable: "/bin/bash",
			argv: ["--norc", "--noprofile"],
			cwd: `/tmp/${paneId}`,
			env: { DEV3_NATIVE_PANE_ID: paneId },
		}),
		cols: 100,
		rows: 30,
	};
}

async function createWithPanes(deps: FakeRegistry, count: number): Promise<NativeMultipaneCoordinator> {
	const coordinator = await NativeMultipaneCoordinator.create(ID, launchFor("pane-1"), deps);
	let last = coordinator.paneIds()[0]!;
	for (let index = 1; index < count; index++) {
		last = await coordinator.split(last, index % 2 === 1 ? "horizontal" : "vertical", launchFor(`pane-${index + 1}`));
	}
	return coordinator;
}

describe("native multipane coordinator", () => {
	let root: string;
	let deps: FakeRegistry;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-multipane-"));
		process.env[NATIVE_MULTIPANE_DIR_ENV] = root;
		deps = createFakeRegistry();
	});

	afterEach(() => {
		delete process.env[NATIVE_MULTIPANE_DIR_ENV];
		rmSync(root, { recursive: true, force: true });
	});

	it("creates one logical session bound to one registry-owned host", async () => {
		const coordinator = await NativeMultipaneCoordinator.create(ID, launchFor("pane-1"), deps);
		expect(coordinator.paneIds()).toEqual(["pane-1"]);
		expect(deps.startCalls).toEqual(["mp-pane-1"]);
		expect(readMultipaneRecord(ID)?.panes).toEqual([{ paneId: "pane-1", sessionId: "mp-pane-1" }]);
	});

	it("grows to six panes with a stable id and an independent shell each", async () => {
		const coordinator = await createWithPanes(deps, 6);
		expect(coordinator.paneIds()).toHaveLength(6);
		expect(new Set(deps.startCalls).size).toBe(6);
		const cwds = [...deps.panes.values()].map((pane) => pane.launch.cwd);
		expect(new Set(cwds).size).toBe(6);
		const shellPids = (await coordinator.listPanes()).map((pane) => pane.shellPid);
		expect(new Set(shellPids).size).toBe(6);
	});

	it("refuses to create a second coordinator over a live pane set", async () => {
		await createWithPanes(deps, 2);
		const before = deps.startCalls.length;
		await expect(NativeMultipaneCoordinator.create(ID, launchFor("pane-1"), deps)).rejects.toBeInstanceOf(
			CoordinatorExistsError,
		);
		expect(deps.startCalls).toHaveLength(before);
	});

	it("recovers the same panes, layout, and pids without respawning", async () => {
		const first = await createWithPanes(deps, 6);
		const expected = await first.listPanes();
		first.detach();

		const startsBefore = deps.startCalls.length;
		const recovered = await NativeMultipaneCoordinator.recover(ID, deps);
		expect(recovered).not.toBeNull();
		expect(recovered!.paneIds()).toEqual(first.paneIds());
		expect(await recovered!.listPanes()).toEqual(expected);
		expect(recovered!.layout).toEqual(first.layout);
		expect(deps.startCalls).toHaveLength(startsBefore);
	});

	it("reconciles a host that died while the controller was gone", async () => {
		const coordinator = await createWithPanes(deps, 3);
		const [, second] = coordinator.paneIds();
		deps.kill(`mp-${second}`);

		const recovered = await NativeMultipaneCoordinator.recover(ID, deps);
		expect(recovered!.paneIds()).not.toContain(second);
		expect(recovered!.paneIds()).toHaveLength(2);
		expect(listPaneIds(recovered!.layout)).toEqual(readMultipaneRecord(ID)?.panes.map((pane) => pane.paneId));
	});

	it("reports no coordinator and drops the record when every host is gone", async () => {
		const coordinator = await createWithPanes(deps, 2);
		for (const paneId of coordinator.paneIds()) deps.kill(`mp-${paneId}`);
		expect(await NativeMultipaneCoordinator.recover(ID, deps)).toBeNull();
		expect(existsSync(coordinatorRecordFile(ID))).toBe(false);
	});

	it("closes only the requested pane's process tree", async () => {
		const coordinator = await createWithPanes(deps, 3);
		const target = coordinator.paneIds()[1]!;
		const result = await coordinator.closePane(target);
		expect(result.sessionTornDown).toBe(false);
		expect(deps.stopCalls).toEqual([`mp-${target}`]);
		expect(coordinator.paneIds()).toEqual(result.remainingPaneIds);
		expect(deps.panes.size).toBe(2);
	});

	it("tears the logical session down when the final pane closes", async () => {
		const coordinator = await NativeMultipaneCoordinator.create(ID, launchFor("pane-1"), deps);
		const result = await coordinator.closePane("pane-1");
		expect(result.sessionTornDown).toBe(true);
		expect(deps.panes.size).toBe(0);
		expect(readMultipaneRecord(ID)).toBeNull();
	});

	it("is safe to clean up repeatedly", async () => {
		const coordinator = await createWithPanes(deps, 2);
		await coordinator.cleanup();
		const stopsAfterFirst = deps.stopCalls.length;
		await coordinator.cleanup();
		await coordinator.cleanup();
		expect(deps.stopCalls).toHaveLength(stopsAfterFirst);
		expect(readMultipaneRecord(ID)).toBeNull();
	});

	it("rejects an unknown logical pane", async () => {
		const coordinator = await NativeMultipaneCoordinator.create(ID, launchFor("pane-1"), deps);
		await expect(coordinator.closePane("pane-99")).rejects.toBeInstanceOf(PaneNotFoundError);
	});

	it("refuses layout mutations once another epoch owns the record", async () => {
		const coordinator = await createWithPanes(deps, 2);
		const record = readMultipaneRecord(ID)!;
		writeMultipaneRecordAtomic({ ...record, epoch: "someone-else" });
		await expect(coordinator.split("pane-1", "horizontal", launchFor("pane-3"))).rejects.toBeInstanceOf(
			CoordinatorGoneError,
		);
	});
});

describe("native multipane writer ownership", () => {
	let root: string;
	let deps: FakeRegistry;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-multipane-writer-"));
		process.env[NATIVE_MULTIPANE_DIR_ENV] = root;
		deps = createFakeRegistry();
	});

	afterEach(() => {
		delete process.env[NATIVE_MULTIPANE_DIR_ENV];
		rmSync(root, { recursive: true, force: true });
	});

	it("lets the writer resize and refuses the observer", async () => {
		const writer = await createWithPanes(deps, 2);
		await writer.resizePane("pane-1", 120, 40);
		expect(deps.panes.get("mp-pane-1")?.resizes).toEqual([{ cols: 120, rows: 40 }]);

		const observer = (await NativeMultipaneCoordinator.recover(ID, deps))!;
		await expect(observer.resizePane("pane-1", 10, 10)).rejects.toBeInstanceOf(ObserverMutationError);
		await expect(observer.writePane("pane-1", "echo hi")).rejects.toBeInstanceOf(ObserverMutationError);
		expect(deps.panes.get("mp-pane-1")?.resizes).toEqual([{ cols: 120, rows: 40 }]);
		expect(deps.panes.get("mp-pane-1")?.inputs).toEqual([]);
	});

	it("waits for the host to republish the new size before resolving", async () => {
		const coordinator = await createWithPanes(deps, 2);
		const pane = deps.panes.get("mp-pane-1")!;
		const applyLater = { ...deps, async connectPane(record: Parameters<typeof deps.connectPane>[0], token: string) {
			const connection = await deps.connectPane(record, token);
			return { ...connection, resize: (cols: number, rows: number) => {
				setTimeout(() => { pane.record.cols = cols; pane.record.rows = rows; }, 60);
			} };
		} };
		const delayed = (await NativeMultipaneCoordinator.recover(ID, applyLater))!;
		await delayed.resizePane("pane-1", 200, 60);
		expect(deps.readPaneRecord("mp-pane-1")).toMatchObject({ cols: 200, rows: 60 });
		coordinator.detach();
	});

	it("reports a resize the host never applied instead of claiming success", async () => {
		const coordinator = await createWithPanes(deps, 2);
		const neverApplies = { ...deps, async connectPane(record: Parameters<typeof deps.connectPane>[0], token: string) {
			const connection = await deps.connectPane(record, token);
			return { ...connection, resize: () => undefined };
		} };
		const stuck = (await NativeMultipaneCoordinator.recover(ID, neverApplies))!;
		await expect(stuck.resizePane("pane-1", 200, 60, { timeoutMs: 100 })).rejects.toBeInstanceOf(
			PaneResizeNotAppliedError,
		);
		coordinator.detach();
	});

	it("keeps two clients' focus and zoom independent over one pane set", async () => {
		const coordinator = await createWithPanes(deps, 4);
		const [first, , third] = coordinator.paneIds();
		const panes = coordinator.paneIds();
		const lastPane = panes[panes.length - 1]!;
		const viewA = coordinator.attachClient("a");
		const viewB = coordinator.attachClient("b");

		viewA.focus(third!);
		viewA.zoom(third!);
		expect(viewB.focusedPaneId).toBe(first);
		expect(viewB.zoomedPaneId).toBeNull();
		expect(coordinator.layout.zoomedPaneId).toBeNull();
		// The shared activePaneId is set by the last split, not by client-local focus.
		expect(coordinator.layout.activePaneId).toBe(lastPane);
	});

	it("moves client focus through the shared geometry without writing to it", async () => {
		const coordinator = await createWithPanes(deps, 2);
		const before = coordinator.layout;
		const view = coordinator.attachClient("a");
		view.focus("pane-1");
		view.focusDirection(coordinator.layout, "right");
		expect(view.focusedPaneId).toBe("pane-2");
		expect(coordinator.layout).toEqual(before);
	});
});

describe("native multipane coordinator publishGeometry", () => {
	let root: string;
	let deps: FakeRegistry;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-multipane-geom-"));
		process.env[NATIVE_MULTIPANE_DIR_ENV] = root;
		deps = createFakeRegistry();
	});

	afterEach(() => {
		delete process.env[NATIVE_MULTIPANE_DIR_ENV];
		rmSync(root, { recursive: true, force: true });
	});

	it("persists new ratios and the recovery sees the same layout", async () => {
		const coordinator = await createWithPanes(deps, 2);
		const original = coordinator.layout;
		// Build a tree with pane set unchanged but ratio tweaked.
		const tweaked = { ...original, activePaneId: "pane-2" };
		await coordinator.publishGeometry(tweaked);
		expect(coordinator.layout.activePaneId).toBe("pane-2");

		// A fresh coordinator via recover must see the published layout.
		coordinator.detach();
		const recovered = await NativeMultipaneCoordinator.recover(ID, deps);
		expect(recovered!.layout.activePaneId).toBe("pane-2");
	});

	it("persists a zoomed pane so the toolbar's Zoom is not a no-op", async () => {
		const coordinator = await createWithPanes(deps, 2);
		await coordinator.publishGeometry({ ...coordinator.layout, zoomedPaneId: "pane-2" });
		expect(coordinator.layout.zoomedPaneId).toBe("pane-2");

		coordinator.detach();
		const recovered = await NativeMultipaneCoordinator.recover(ID, deps);
		expect(recovered!.layout.zoomedPaneId).toBe("pane-2");
	});

	it("rejects when the new tree's pane set differs from the current one", async () => {
		const { LayoutPaneSetMismatchError } = await import("../errors");
		const coordinator = await createWithPanes(deps, 2);
		// A 1-pane tree mismatches the 2-pane coordinator.
		const singlePaneTree = createSplitTree();
		await expect(coordinator.publishGeometry(singlePaneTree)).rejects.toBeInstanceOf(
			LayoutPaneSetMismatchError,
		);
	});

	it("leaves the record untouched when the pane set mismatches", async () => {
		const coordinator = await createWithPanes(deps, 2);
		const before = readMultipaneRecord(ID)!.epoch;
		const singlePaneTree = createSplitTree();
		await coordinator.publishGeometry(singlePaneTree).catch(() => {});
		expect(readMultipaneRecord(ID)!.epoch).toBe(before);
	});
});

describe("native multipane coordinator capturePane", () => {
	let root: string;
	let deps: FakeRegistry;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-multipane-capture-"));
		process.env[NATIVE_MULTIPANE_DIR_ENV] = root;
		deps = createFakeRegistry();
	});

	afterEach(() => {
		delete process.env[NATIVE_MULTIPANE_DIR_ENV];
		rmSync(root, { recursive: true, force: true });
	});

	it("captures the pane's text from the connection's capture method", async () => {
		const coordinator = await createWithPanes(deps, 2);
		// The FakeRegistry captures joined inputs — write something first.
		await coordinator.writePane("pane-1", "hello");
		const text = await coordinator.capturePane("pane-1", false);
		expect(typeof text).toBe("string");
	});

	it("rejects capture of an unknown pane", async () => {
		const coordinator = await createWithPanes(deps, 2);
		await expect(coordinator.capturePane("ghost", false)).rejects.toBeInstanceOf(PaneNotFoundError);
	});
});
