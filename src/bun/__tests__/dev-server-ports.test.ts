import { describe, it, expect, beforeEach } from "vitest";
import {
	classifyAgainstStartSnapshot,
	classifyAssignedPortOwners,
	clearCarriedPublished,
	clearDevServerStart,
	clearDevServerStartsForTask,
	getDevServerStartSnapshot,
	getTaskStartSnapshot,
	mergePortInfos,
	recordDevServerStart,
} from "../dev-server-ports";

const DOCKER = { port: 10569, pid: 1380, processName: "com.docker.backend" };
const SQUATTER = { port: 10570, pid: 999, processName: "node" };

describe("classifyAssignedPortOwners", () => {
	it("treats a foreign holder that appeared after start as published for the dev server", () => {
		const { published, conflicts } = classifyAssignedPortOwners([DOCKER], [], true);
		expect(published).toEqual([DOCKER]);
		expect(conflicts).toEqual([]);
	});

	it("treats a holder already listening before start as a conflict", () => {
		const { published, conflicts } = classifyAssignedPortOwners([SQUATTER], [SQUATTER], true);
		expect(published).toEqual([]);
		expect(conflicts).toEqual([SQUATTER]);
	});

	it("separates a published port from a squatter in the same snapshot", () => {
		const { published, conflicts } = classifyAssignedPortOwners([DOCKER, SQUATTER], [SQUATTER], true);
		expect(published).toEqual([DOCKER]);
		expect(conflicts).toEqual([SQUATTER]);
	});

	it("counts a same-port holder with a different pid as published, not the old squatter", () => {
		const { published, conflicts } = classifyAssignedPortOwners(
			[DOCKER],
			[{ ...DOCKER, pid: 4242 }],
			true,
		);
		expect(published).toEqual([DOCKER]);
		expect(conflicts).toEqual([]);
	});

	it("calls every holder a conflict when the dev server is not running", () => {
		const { published, conflicts } = classifyAssignedPortOwners([DOCKER, SQUATTER], [], false);
		expect(published).toEqual([]);
		expect(conflicts).toEqual([DOCKER, SQUATTER]);
	});
});

describe("dev server start snapshot", () => {
	beforeEach(() => {
		clearDevServerStart("task-1", "dev");
	});

	it("has no snapshot until a dev server start records one", () => {
		expect(getDevServerStartSnapshot("task-1", "dev")).toBeNull();
		recordDevServerStart("task-1", "dev", [10569], []);
		expect(getDevServerStartSnapshot("task-1", "dev")).toEqual({ assignedPorts: [10569], preStartHolders: [] });
	});

	it("copies the holders so a later mutation cannot rewrite history", () => {
		const holders = [{ ...SQUATTER }];
		recordDevServerStart("task-1", "dev", [10570], holders);
		holders[0].pid = 1;
		expect(getDevServerStartSnapshot("task-1", "dev")?.preStartHolders).toEqual([SQUATTER]);
	});

	it("drops the snapshot on teardown", () => {
		recordDevServerStart("task-1", "dev", [10570], [SQUATTER]);
		clearDevServerStart("task-1", "dev");
		expect(getDevServerStartSnapshot("task-1", "dev")).toBeNull();
	});
});

describe("classifyAgainstStartSnapshot", () => {
	beforeEach(() => {
		clearDevServerStart("task-2", "dev");
		clearCarriedPublished("task-2");
	});

	// Without this, an app restart under a surviving dev session turns every
	// squatter into a "published" port: the WARNING disappears and the squatted
	// port is reported as one of the task's own.
	it("calls every holder a conflict when this process never started that dev server", () => {
		const { published, conflicts } = classifyAgainstStartSnapshot("task-2", "dev", [SQUATTER], true);
		expect(published).toEqual([]);
		expect(conflicts).toEqual([SQUATTER]);
	});

	it("classifies against the recorded snapshot once a start was seen", () => {
		recordDevServerStart("task-2", "dev", [10569], []);
		const { published, conflicts } = classifyAgainstStartSnapshot("task-2", "dev", [DOCKER], true);
		expect(published).toEqual([DOCKER]);
		expect(conflicts).toEqual([]);
	});

	// `docker compose up` is HUPed by kill-session and SIGKILLed 1.5s later, so
	// the container — and the daemon holding its published port — outlives the
	// stop. Reading that daemon back as a squatter made every `restart --wait`
	// fail on the containerised project this whole mechanism is for.
	it("forgives a published holder that survived the stop, on the next start", () => {
		recordDevServerStart("task-2", "dev", [10569], []);
		classifyAgainstStartSnapshot("task-2", "dev", [DOCKER], true);
		clearDevServerStart("task-2", "dev");

		recordDevServerStart("task-2", "dev", [10569], [DOCKER]);
		expect(getDevServerStartSnapshot("task-2", "dev")?.preStartHolders).toEqual([]);
		expect(classifyAgainstStartSnapshot("task-2", "dev", [DOCKER], true)).toEqual({
			published: [DOCKER],
			conflicts: [],
		});
	});

	it("keeps a squatter that was never published a conflict across a restart", () => {
		recordDevServerStart("task-2", "dev", [10570], [SQUATTER]);
		expect(classifyAgainstStartSnapshot("task-2", "dev", [SQUATTER], true).conflicts).toEqual([SQUATTER]);
		clearDevServerStart("task-2", "dev");

		recordDevServerStart("task-2", "dev", [10570], [SQUATTER]);
		expect(getDevServerStartSnapshot("task-2", "dev")?.preStartHolders).toEqual([SQUATTER]);
		expect(classifyAgainstStartSnapshot("task-2", "dev", [SQUATTER], true).conflicts).toEqual([SQUATTER]);
	});

	it("forgives only the exact port and pid that was published", () => {
		recordDevServerStart("task-2", "dev", [10569], []);
		classifyAgainstStartSnapshot("task-2", "dev", [DOCKER], true);
		clearDevServerStart("task-2", "dev");

		const otherPid = { ...DOCKER, pid: 4242, processName: "node" };
		recordDevServerStart("task-2", "dev", [10569], [otherPid]);
		expect(getDevServerStartSnapshot("task-2", "dev")?.preStartHolders).toEqual([otherPid]);
		expect(classifyAgainstStartSnapshot("task-2", "dev", [otherPid], true).conflicts).toEqual([otherPid]);
	});

	it("remembers nothing while the dev server is stopped", () => {
		recordDevServerStart("task-2", "dev", [10569], []);
		expect(classifyAgainstStartSnapshot("task-2", "dev", [DOCKER], false).conflicts).toEqual([DOCKER]);
		clearDevServerStart("task-2", "dev");

		recordDevServerStart("task-2", "dev", [10569], [DOCKER]);
		expect(getDevServerStartSnapshot("task-2", "dev")?.preStartHolders).toEqual([DOCKER]);
	});
});

// A task runs one dev server per declared name, and each keeps its own history:
// a port the API server bound is not a squatter on the front end just because
// the front end started later.
describe("per-server snapshots", () => {
	beforeEach(() => {
		clearDevServerStartsForTask("task-3");
		clearCarriedPublished("task-3");
	});

	it("keeps one snapshot per server", () => {
		recordDevServerStart("task-3", "dev", [10569], []);
		recordDevServerStart("task-3", "api", [10570], [SQUATTER]);
		expect(getDevServerStartSnapshot("task-3", "dev")).toEqual({ assignedPorts: [10569], preStartHolders: [] });
		expect(getDevServerStartSnapshot("task-3", "api")?.preStartHolders).toEqual([SQUATTER]);
	});

	it("stopping one server leaves the other's snapshot alone", () => {
		recordDevServerStart("task-3", "dev", [10569], []);
		recordDevServerStart("task-3", "api", [10570], []);
		clearDevServerStart("task-3", "api");
		expect(getDevServerStartSnapshot("task-3", "api")).toBeNull();
		expect(getDevServerStartSnapshot("task-3", "dev")).not.toBeNull();
	});

	// The board scan knows a task, not a server, so it asks about the union.
	it("merges every server's snapshot for a task-wide read", () => {
		recordDevServerStart("task-3", "dev", [10569], []);
		recordDevServerStart("task-3", "api", [10570], [SQUATTER]);
		expect(getTaskStartSnapshot("task-3")).toEqual({
			assignedPorts: [10569, 10570],
			preStartHolders: [SQUATTER],
		});
		clearDevServerStartsForTask("task-3");
		expect(getTaskStartSnapshot("task-3")).toBeNull();
	});
});

describe("mergePortInfos", () => {
	it("keeps the first entry per port and sorts by port", () => {
		const owned = { port: 5173, pid: 10, processName: "bun" };
		const duplicate = { port: 5173, pid: 11, processName: "com.docker.backend" };
		expect(mergePortInfos([owned], [duplicate, DOCKER])).toEqual([owned, DOCKER]);
	});
});
