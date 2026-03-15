import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// Mock DEV3_HOME to a temp directory
vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-port-pool-test",
}));

const TEST_HOME = "/tmp/dev3-port-pool-test";

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

import { allocatePorts, releasePorts, getPortAssignments, getAllAssignments, buildPortEnv, _resetState } from "../port-pool";

describe("port-pool", () => {
	beforeEach(() => {
		_resetState();
		portsInUse = new Set();
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
		});

		it("returns existing allocation if count matches", async () => {
			const first = await allocatePorts("task-2", 2);
			const second = await allocatePorts("task-2", 2);
			expect(second).toEqual(first);
		});

		it("re-allocates if count changes", async () => {
			const first = await allocatePorts("task-3", 2);
			expect(first).toHaveLength(2);
			const second = await allocatePorts("task-3", 3);
			expect(second).toHaveLength(3);
		});

		it("returns empty array for count 0", async () => {
			const ports = await allocatePorts("task-4", 0);
			expect(ports).toEqual([]);
		});

		it("throws for count exceeding maximum", async () => {
			await expect(allocatePorts("task-5", 21)).rejects.toThrow("exceeds maximum");
		});

		it("skips ports that are in use by the OS", async () => {
			// Mark first 100 ports in range as in use
			for (let i = 10000; i < 10100; i++) {
				portsInUse.add(i);
			}
			const ports = await allocatePorts("task-6", 2);
			for (const p of ports) {
				expect(portsInUse.has(p)).toBe(false);
			}
		});

		it("prevents double-allocation across tasks", async () => {
			const ports1 = await allocatePorts("task-a", 5);
			const ports2 = await allocatePorts("task-b", 5);
			const set1 = new Set(ports1);
			for (const p of ports2) {
				expect(set1.has(p)).toBe(false);
			}
		});

		it("persists allocations to disk", async () => {
			await allocatePorts("task-persist", 2);
			const filePath = join(TEST_HOME, "port-assignments.json");
			expect(existsSync(filePath)).toBe(true);
			const data = JSON.parse(readFileSync(filePath, "utf-8"));
			expect(data["task-persist"]).toHaveLength(2);
		});

		it("loads persisted allocations on fresh start", async () => {
			const filePath = join(TEST_HOME, "port-assignments.json");
			writeFileSync(filePath, JSON.stringify({ "task-pre": [12345, 12346] }));
			_resetState();

			const ports = getPortAssignments("task-pre");
			expect(ports).toEqual([12345, 12346]);
		});
	});

	describe("releasePorts", () => {
		it("releases ports for a task", async () => {
			await allocatePorts("task-r", 2);
			const released = releasePorts("task-r");
			expect(released).toHaveLength(2);
			expect(getPortAssignments("task-r")).toEqual([]);
		});

		it("returns empty array for unknown task", () => {
			const released = releasePorts("nonexistent");
			expect(released).toEqual([]);
		});

		it("makes released ports available for re-allocation", async () => {
			await allocatePorts("task-free", 3);
			releasePorts("task-free");
			// After release, these ports can be assigned to another task
			const all = getAllAssignments();
			expect(all["task-free"]).toBeUndefined();
		});
	});

	describe("getPortAssignments", () => {
		it("returns empty array for task with no allocation", () => {
			expect(getPortAssignments("no-such-task")).toEqual([]);
		});

		it("returns current allocation for active task", async () => {
			const ports = await allocatePorts("task-get", 2);
			expect(getPortAssignments("task-get")).toEqual(ports);
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
		});

		it("returns a copy (not a reference)", async () => {
			await allocatePorts("t-copy", 1);
			const all = getAllAssignments();
			delete all["t-copy"];
			// Original should still have it
			expect(getPortAssignments("t-copy")).toHaveLength(1);
		});
	});

	describe("buildPortEnv", () => {
		it("returns empty object for empty ports array", () => {
			expect(buildPortEnv([])).toEqual({});
		});

		it("builds correct env vars", () => {
			const env = buildPortEnv([12000, 12001, 12002]);
			expect(env).toEqual({
				DEV3_PORT_COUNT: "3",
				DEV3_PORTS: "12000,12001,12002",
				DEV3_PORT0: "12000",
				DEV3_PORT1: "12001",
				DEV3_PORT2: "12002",
			});
		});

		it("handles single port", () => {
			const env = buildPortEnv([15000]);
			expect(env).toEqual({
				DEV3_PORT_COUNT: "1",
				DEV3_PORTS: "15000",
				DEV3_PORT0: "15000",
			});
		});
	});
});
