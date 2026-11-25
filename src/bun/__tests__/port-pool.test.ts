import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/port-pool`);

// Mock DEV3_HOME to a temp directory
vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

// Mock net/dgram to control port availability
let portsInUse = new Set<number>();

vi.mock("node:net", () => ({
	createServer: () => {
		return {
			once(event: string, cb: () => void) {
				if (event === "error") {
					(this as any)._errorCb = cb;
				}
			},
			listen(p: number, _h: string, cb: () => void) {
				if (portsInUse.has(p)) {
					(this as any)._errorCb?.();
				} else {
					cb();
				}
			},
			close(cb?: () => void) {
				cb?.();
			},
		};
	},
}));

vi.mock("node:dgram", () => ({
	createSocket: () => {
		return {
			once(event: string, cb: () => void) {
				if (event === "error") {
					(this as any)._errorCb = cb;
				}
			},
			bind(_port: number, _host: string, cb: () => void) {
				cb();
			},
			close(cb?: () => void) {
				cb?.();
			},
		};
	},
}));

// Real locking by default; individual tests make acquisition fail on demand.
const lockControl = vi.hoisted(() => ({ failWith: null as Error | null }));

vi.mock("../file-lock", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../file-lock")>();
	return {
		...actual,
		withFileLock: (path: string, fn: () => Promise<unknown>, options?: unknown) => {
			if (lockControl.failWith) return Promise.reject(lockControl.failWith);
			return actual.withFileLock(path, fn, options as never);
		},
	};
});

import { FileLockTimeoutError } from "../file-lock";
import { allocatePorts, releasePorts, getPortAssignments, getAllAssignments, buildPortEnv, buildNamedPortEnv, _resetState } from "../port-pool";

describe("port-pool", () => {
	beforeEach(() => {
		_resetState();
		portsInUse = new Set();
		lockControl.failWith = null;
		mkdirSync(TEST_HOME, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(TEST_HOME, { recursive: true, force: true });
		} catch { /* ignore */ }
	});

	describe("allocatePorts", () => {
		it("allocates the requested number of ports", async () => {
			const ports = await allocatePorts("task-1", 3);
			expect(ports).toHaveLength(3);
			// All ports in range
			for (const p of ports) {
				expect(p).toBeGreaterThanOrEqual(10000);
				expect(p).toBeLessThan(20000);
			}
			// All unique
			expect(new Set(ports).size).toBe(3);
			// Same count again returns the existing allocation.
			expect(await allocatePorts("task-1", 3)).toEqual(ports);
		});

		// A task's port count grows whenever a dev server declares a new named
		// port. Reallocating would move DEV3_PORT0 out from under a server that
		// is already bound to it, so the existing ports have to stay put.
		it("extends the assignment when the count grows and trims it when it shrinks, keeping the ports already handed out", async () => {
			const first = await allocatePorts("task-3", 2);
			expect(first).toHaveLength(2);
			const second = await allocatePorts("task-3", 3);
			expect(second).toHaveLength(3);
			expect(second.slice(0, 2)).toEqual(first);
			expect(new Set(second).size).toBe(3);
			// Shrinking keeps the first ports.
			const shrunk = await allocatePorts("task-3", 2);
			expect(shrunk).toEqual(first);
			expect(getPortAssignments("task-3")).toEqual(shrunk);
		});

		it("returns empty array for count 0 and throws for count exceeding maximum", async () => {
			expect(await allocatePorts("task-4", 0)).toEqual([]);
			await expect(allocatePorts("task-5", 21)).rejects.toThrow("exceeds maximum");
		});

		it("skips ports in use by the OS and never double-allocates across tasks", async () => {
			// Mark first 100 ports in range as in use
			for (let i = 10000; i < 10100; i++) {
				portsInUse.add(i);
			}
			const ports = await allocatePorts("task-6", 2);
			for (const p of ports) {
				expect(portsInUse.has(p)).toBe(false);
			}
			// No double-allocation across tasks.
			const ports1 = await allocatePorts("task-a", 5);
			const ports2 = await allocatePorts("task-b", 5);
			const set1 = new Set(ports1);
			for (const p of ports2) {
				expect(set1.has(p)).toBe(false);
			}
		});

		it("does not assign overlapping ports to concurrent allocations", async () => {
			// Regression: two task variants created in parallel each called
			// allocatePorts() concurrently. Without serialization, both took the
			// same assigned-port snapshot before either persisted, so they could
			// pick the same OS-free ports and collide (overlapping DEV3_PORT0 →
			// dev-server bind clashes). Constrain the free window to exactly the
			// number of ports both need combined: a correct implementation must
			// partition them, a racing one overlaps.
			for (let i = 10000; i < 20000; i++) portsInUse.add(i);
			for (let i = 10000; i < 10020; i++) portsInUse.delete(i);

			const [a, b] = await Promise.all([
				allocatePorts("task-concurrent-a", 10),
				allocatePorts("task-concurrent-b", 10),
			]);

			expect(a).toHaveLength(10);
			expect(b).toHaveLength(10);
			const overlap = a.filter((p) => b.includes(p));
			expect(overlap).toEqual([]);
		});

		it("persists allocations to disk", async () => {
			await allocatePorts("task-persist", 2);
			const filePath = join(TEST_HOME, "port-assignments.json");
			expect(existsSync(filePath)).toBe(true);
			const data = JSON.parse(readFileSync(filePath, "utf-8"));
			expect(data["task-persist"]).toHaveLength(2);

			// Loads persisted allocations on fresh start.
			writeFileSync(filePath, JSON.stringify({ "task-pre": [12345, 12346] }));
			_resetState();

			const ports = getPortAssignments("task-pre");
			expect(ports).toEqual([12345, 12346]);
		});
	});

	describe("releasePorts", () => {
		it("releases ports for a task", async () => {
			await allocatePorts("task-r", 2);
			const released = await releasePorts("task-r");
			expect(released).toHaveLength(2);
			expect(getPortAssignments("task-r")).toEqual([]);
			expect(getAllAssignments()["task-r"]).toBeUndefined();
			expect(await releasePorts("nonexistent")).toEqual([]);
		});

		it("does not drop a peer allocation that landed while releasing", async () => {
			// Regression: releasePorts() rewrote port-assignments.json from the
			// in-memory cache without the cross-process lock allocatePorts()
			// holds. A second app instance allocating between this process's
			// load and its save had its record silently erased, freeing its
			// ports for a duplicate assignment. Simulate the peer by writing
			// behind the cache, the way another process would.
			await allocatePorts("task-old", 2);
			const filePath = join(TEST_HOME, "port-assignments.json");
			const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
			onDisk["task-peer"] = [19998, 19999];
			writeFileSync(filePath, JSON.stringify(onDisk));

			await releasePorts("task-old");

			_resetState();
			expect(getPortAssignments("task-peer")).toEqual([19998, 19999]);
			expect(getPortAssignments("task-old")).toEqual([]);
		});

		it("leaves the assignment on disk when the lock times out, and propagates any other lock failure", async () => {
			// Teardown must not stall or throw on a contended lock: the effect
			// runs with the "continue" policy, so a rejection here would only
			// surface as a generic lifecycle warning. Swallow the timeout, keep
			// the record intact rather than writing an unsynchronized map.
			await allocatePorts("task-stuck", 2);
			const filePath = join(TEST_HOME, "port-assignments.json");
			const before = JSON.parse(readFileSync(filePath, "utf-8"));

			lockControl.failWith = new FileLockTimeoutError(`${filePath}.lock`, 5000, 3);
			const released = await releasePorts("task-stuck");

			expect(released).toEqual([]);
			expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(before);

			// A lock failure that is not a timeout propagates.
			lockControl.failWith = new Error("EACCES: permission denied");
			await expect(releasePorts("task-any")).rejects.toThrow("EACCES");
		});
	});

	describe("getAllAssignments", () => {
		it("returns all current allocations", async () => {
			await allocatePorts("t1", 1);
			await allocatePorts("t2", 2);
			const all = getAllAssignments();
			expect(Object.keys(all)).toHaveLength(2);
			expect(all["t1"]).toHaveLength(1);
			expect(all["t2"]).toHaveLength(2);
			// A copy, not a reference.
			delete all["t1"];
			expect(getPortAssignments("t1")).toHaveLength(1);
		});
	});

	describe("buildPortEnv", () => {
		it("builds correct env vars", () => {
			expect(buildPortEnv([])).toEqual({});
			const env = buildPortEnv([12000, 12001, 12002]);
			expect(env).toEqual({
				DEV3_PORT_COUNT: "3",
				DEV3_PORTS: "12000,12001,12002",
				DEV3_PORT0: "12000",
				DEV3_PORT1: "12001",
				DEV3_PORT2: "12002",
			});
		});

		// Every dev server of a task receives every named port, which is what lets
		// the back office call the API without anyone wiring ports by hand.
		it("names each port's variable after the port, not its position", () => {
			expect(buildNamedPortEnv({ api: 12001, "back-office": 12002 })).toEqual({
				DEV3_PORT_API: "12001",
				DEV3_PORT_BACK_OFFICE: "12002",
			});
			expect(buildNamedPortEnv({})).toEqual({});
		});
	});
});
