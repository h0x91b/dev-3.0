import { describe, expect, it } from "vitest";
import type { CpuInfo } from "node:os";
import type { SystemLoadSnapshot } from "../../shared/types";
import { DEFAULT_RESOURCE_LEVELS } from "../../shared/types";
import { classifyCpu, classifyDisk, cpuBusyRatio, cpuLoadPercent, groupCpuConsumers, loadSnapshotWorthPushing, parseDuOutput, sumCpuTimes } from "../system-load";

function core(user: number, idle: number): CpuInfo {
	return { model: "x", speed: 0, times: { user, nice: 0, sys: 0, idle, irq: 0 } };
}

function snapshot(overrides?: Partial<SystemLoadSnapshot>): SystemLoadSnapshot {
	return {
		cpuBusy: 0.2,
		cpuLoadPercent: 30,
		cpuPressure: "normal",
		cores: 8,
		loadAvg: [1, 1, 1],
		topCpuConsumers: [],
		appCpu: 3,
		topCpuTasks: [],
		disk: { free: 100 * 1024 ** 3, total: 500 * 1024 ** 3, pressure: "normal" },
		...overrides,
	};
}

describe("cpuBusyRatio", () => {
	it("is the busy share of the time that elapsed across all cores", () => {
		const prev = sumCpuTimes([core(100, 900), core(100, 900)]);
		const next = sumCpuTimes([core(250, 950), core(200, 1000)]);
		// 250 busy of 400 elapsed
		expect(cpuBusyRatio(prev, next)).toBeCloseTo(0.625);
	});

	it("has no reading without a previous sample or elapsed time", () => {
		const times = sumCpuTimes([core(1, 1)]);
		expect(cpuBusyRatio(null, times)).toBeNull();
		expect(cpuBusyRatio(times, times)).toBeNull();
	});
});

describe("groupCpuConsumers", () => {
	it("groups per application by cpu and drops idle processes", () => {
		const groups = groupCpuConsumers(
			[
				{ pid: 1, cpu: 30, cmdline: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
				{ pid: 2, cpu: 20, cmdline: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer" },
				{ pid: 3, cpu: 40, cmdline: "/usr/local/bin/dockerd" },
				{ pid: 4, cpu: 0, cmdline: "/usr/sbin/idle-daemon" },
			],
			5,
		);
		expect(groups.map((g) => [g.name, g.cpu, g.processCount])).toEqual([
			["Google Chrome", 50, 2],
			["Docker", 40, 1],
		]);
		expect(groups[0]).not.toHaveProperty("rss");
	});
});

describe("parseDuOutput", () => {
	it("maps each path to bytes and skips noise", () => {
		const sizes = parseDuOutput("2048\t/a/worktree\n10\t/b/with space/worktree\nbogus line\n\n");
		expect(sizes.get("/a/worktree")).toBe(2048 * 1024);
		expect(sizes.get("/b/with space/worktree")).toBe(10 * 1024);
		expect(sizes.size).toBe(2);
	});
});

describe("loadSnapshotWorthPushing", () => {
	it("ignores jitter but pushes real movement", () => {
		expect(loadSnapshotWorthPushing(null, snapshot())).toBe(true);
		expect(loadSnapshotWorthPushing(snapshot(), snapshot({ cpuBusy: 0.22 }))).toBe(false);
		expect(loadSnapshotWorthPushing(snapshot(), snapshot({ cpuBusy: 0.3 }))).toBe(true);
		expect(loadSnapshotWorthPushing(snapshot(), snapshot({ disk: { free: 98 * 1024 ** 3, total: 500 * 1024 ** 3, pressure: "normal" } }))).toBe(true);
		expect(loadSnapshotWorthPushing(snapshot(), snapshot({ disk: null }))).toBe(true);
		expect(loadSnapshotWorthPushing(snapshot(), snapshot({ cpuPressure: "warn" }))).toBe(true);
	});
});

describe("levels", () => {
	const levels = DEFAULT_RESOURCE_LEVELS;

	it("judges CPU on load as a % of cores, falling back to busy % without a load average", () => {
		expect(cpuLoadPercent(12, 12, 0.3)).toBe(100);
		expect(cpuLoadPercent(0, 12, 0.3)).toBeCloseTo(30);
		expect(classifyCpu(99, levels)).toBe("normal");
		expect(classifyCpu(100, levels)).toBe("warn");
		expect(classifyCpu(150, levels)).toBe("critical");
	});

	it("judges disk on free decimal GB", () => {
		expect(classifyDisk(25e9, levels)).toBe("normal");
		expect(classifyDisk(19.9e9, levels)).toBe("warn");
		expect(classifyDisk(4e9, levels)).toBe("critical");
		expect(classifyDisk(4e9, { ...levels, diskCriticalGb: 2 })).toBe("warn");
	});
});
