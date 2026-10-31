import { statfsSync } from "node:fs";
import type { CpuInfo } from "node:os";
import type { CpuConsumerGroup, MemoryPressure, ResourceLevels, SystemLoadSnapshot } from "../shared/types";
import { groupConsumers } from "./system-memory";

/**
 * Pure helpers behind the CPU and disk rows of the header kebab. The poller in
 * `resource-monitor.ts` feeds them from the same `ps` sample as the memory
 * snapshot; nothing here spawns.
 */

export interface CpuTimes {
	idle: number;
	total: number;
}

export function sumCpuTimes(cpus: CpuInfo[]): CpuTimes {
	let idle = 0;
	let total = 0;
	for (const { times } of cpus) {
		idle += times.idle;
		total += times.user + times.nice + times.sys + times.idle + times.irq;
	}
	return { idle, total };
}

/** Busy share of all cores between two samples, 0..1. Null on the first sample. */
export function cpuBusyRatio(prev: CpuTimes | null, next: CpuTimes): number | null {
	if (!prev) return null;
	const total = next.total - prev.total;
	if (total <= 0) return null;
	return Math.min(1, Math.max(0, 1 - (next.idle - prev.idle) / total));
}

/** Top CPU consumers grouped per application, idle processes dropped. */
export function groupCpuConsumers(
	processes: Array<{ pid: number; cpu: number; cmdline: string }>,
	limit: number,
): CpuConsumerGroup[] {
	// groupConsumers ranks by `rss`; feeding it cpu reuses the per-app grouping as is.
	return groupConsumers(
		processes.filter((p) => p.cpu > 0).map((p) => ({ pid: p.pid, rss: p.cpu, cmdline: p.cmdline })),
		limit,
	).map(({ rss, ...group }) => ({ ...group, cpu: rss }));
}

export function readDiskFacts(path: string): { free: number; total: number } | null {
	try {
		const fs = statfsSync(path);
		return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
	} catch {
		return null;
	}
}

/**
 * Judged on sampled busy time, not load average: macOS counts threads blocked
 * on I/O in the load, so it reads 600% on a 30%-busy machine and lags minutes
 * behind (decisions/2026/10/31/cpu-pressure-from-busy-time-not-load-average.md).
 */
export function classifyCpu(busy: number, levels: ResourceLevels): MemoryPressure {
	const percent = busy * 100;
	if (percent >= levels.cpuBusyCriticalPercent) return "critical";
	return percent >= levels.cpuBusyWarnPercent ? "warn" : "normal";
}

/** Levels are decimal GB because that is the unit Finder and `df -H` show. */
export function classifyDisk(freeBytes: number, levels: ResourceLevels): MemoryPressure {
	const freeGb = freeBytes / 1e9;
	if (freeGb < levels.diskCriticalGb) return "critical";
	return freeGb < levels.diskWarnGb ? "warn" : "normal";
}

/** Parse `du -sk` output ("<kib>\t<path>" per line) into bytes per path. */
export function parseDuOutput(output: string): Map<string, number> {
	const sizes = new Map<string, number>();
	for (const line of output.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const kib = Number(line.slice(0, tab));
		if (Number.isFinite(kib)) sizes.set(line.slice(tab + 1), kib * 1024);
	}
	return sizes;
}

const CPU_PUSH_THRESHOLD = 0.05;
const DISK_PUSH_THRESHOLD = 1024 * 1024 * 1024;

export function loadSnapshotWorthPushing(prev: SystemLoadSnapshot | null, next: SystemLoadSnapshot): boolean {
	if (!prev) return true;
	if (prev.cpuPressure !== next.cpuPressure || prev.disk?.pressure !== next.disk?.pressure) return true;
	if (Math.abs(next.cpuBusy - prev.cpuBusy) >= CPU_PUSH_THRESHOLD) return true;
	if (!prev.disk !== !next.disk) return true;
	if (prev.disk && next.disk && Math.abs(next.disk.free - prev.disk.free) >= DISK_PUSH_THRESHOLD) return true;
	const names = (s: SystemLoadSnapshot) => s.topCpuConsumers.map((c) => c.name).join(" ");
	if (names(prev) !== names(next)) return true;
	const tasks = (s: SystemLoadSnapshot) => s.topCpuTasks.map((t) => t.shortId).join(" ");
	return tasks(prev) !== tasks(next);
}
