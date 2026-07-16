import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTaskSocketOwner, socketMetaPathFor, taskSocketOwnerPath } from "../../shared/socket-meta";
import { claimSocketTaskOwnership, releaseSocketTaskOwnership } from "../socket-task-ownership";

const TASK_A = "aaaaaaaa-1111-4111-8111-111111111111";
const TASK_B = "bbbbbbbb-2222-4222-8222-222222222222";

describe("socket task ownership", () => {
	let dir: string;
	let socketPath: string;
	let metaPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dev3-socket-owner-"));
		socketPath = join(dir, "4242.sock");
		metaPath = socketMetaPathFor(socketPath);
		writeFileSync(socketPath, "");
		writeFileSync(metaPath, JSON.stringify({
			pid: 4242,
			hostTaskId: "cccccccc-3333-4333-8333-333333333333",
			startedAt: "2026-07-16T00:00:00.000Z",
			ownerKey: "remote:18856",
		}));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes a full-UUID logical owner claim in place", () => {
		expect(claimSocketTaskOwnership(socketPath, TASK_A, 1234)).toBe(true);

		const ownerPath = taskSocketOwnerPath(dir, TASK_A)!;
		const owner = parseTaskSocketOwner(readFileSync(ownerPath, "utf-8"));
		expect(owner).toEqual({
			taskId: TASK_A,
			ownerKey: "remote:18856",
			claimedAt: 1234,
			claimantPid: 4242,
		});
		expect(readdirSync(dirname(ownerPath))).toEqual([`${TASK_A}.json`]);
	});

	it("rejects prefixes and pid-mismatched socket metadata", () => {
		expect(claimSocketTaskOwnership(socketPath, TASK_A.slice(0, 8), 1234)).toBe(false);
		writeFileSync(metaPath, JSON.stringify({
			pid: 9999,
			hostTaskId: null,
			startedAt: "",
			ownerKey: "remote:18856",
		}));
		expect(claimSocketTaskOwnership(socketPath, TASK_A, 1234)).toBe(false);
		expect(taskSocketOwnerPath(dir, TASK_A)).not.toBeNull();
		expect(existsSync(taskSocketOwnerPath(dir, TASK_A)!)).toBe(false);
	});

	it("an old process cannot release a restarted server's refreshed claim", () => {
		const ownerPath = taskSocketOwnerPath(dir, TASK_A)!;
		mkdirSync(dirname(ownerPath), { recursive: true });
		writeFileSync(ownerPath, JSON.stringify({
			taskId: TASK_A,
			ownerKey: "remote:18856",
			claimedAt: 2000,
			claimantPid: 5252,
		}));

		expect(releaseSocketTaskOwnership(socketPath, TASK_A)).toBe(false);
		expect(parseTaskSocketOwner(readFileSync(ownerPath, "utf-8"))?.claimantPid).toBe(5252);
	});

	it("matching teardown removes only its own task claim", () => {
		expect(claimSocketTaskOwnership(socketPath, TASK_A, 1000)).toBe(true);
		expect(claimSocketTaskOwnership(socketPath, TASK_B, 2000)).toBe(true);

		expect(releaseSocketTaskOwnership(socketPath, TASK_A)).toBe(true);

		expect(existsSync(taskSocketOwnerPath(dir, TASK_A)!)).toBe(false);
		expect(existsSync(taskSocketOwnerPath(dir, TASK_B)!)).toBe(true);
	});
});
