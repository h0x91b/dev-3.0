import { describe, it, expect, beforeEach } from "vitest";
import {
	classifyAssignedPortOwners,
	clearDevServerStart,
	getDevServerStartSnapshot,
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
		clearDevServerStart("task-1");
	});

	it("has no snapshot until a dev server start records one", () => {
		expect(getDevServerStartSnapshot("task-1")).toBeNull();
		recordDevServerStart("task-1", [10569], []);
		expect(getDevServerStartSnapshot("task-1")).toEqual({ assignedPorts: [10569], preStartHolders: [] });
	});

	it("copies the holders so a later mutation cannot rewrite history", () => {
		const holders = [{ ...SQUATTER }];
		recordDevServerStart("task-1", [10570], holders);
		holders[0].pid = 1;
		expect(getDevServerStartSnapshot("task-1")?.preStartHolders).toEqual([SQUATTER]);
	});

	it("drops the snapshot on teardown", () => {
		recordDevServerStart("task-1", [10570], [SQUATTER]);
		clearDevServerStart("task-1");
		expect(getDevServerStartSnapshot("task-1")).toBeNull();
	});
});

describe("mergePortInfos", () => {
	it("keeps the first entry per port and sorts by port", () => {
		const owned = { port: 5173, pid: 10, processName: "bun" };
		const duplicate = { port: 5173, pid: 11, processName: "com.docker.backend" };
		expect(mergePortInfos([owned], [duplicate, DOCKER])).toEqual([owned, DOCKER]);
	});
});
