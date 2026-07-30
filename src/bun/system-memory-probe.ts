import { readFile } from "node:fs/promises";
import { spawn } from "./spawn";
import { parseLinuxMemory, parseMacMemory, type MemoryFacts } from "./system-memory";

/**
 * Platform I/O for system memory. This file reads; `system-memory.ts` computes.
 * Nothing here derives a number, so every figure stays testable without mocks.
 *
 * Cost per call: macOS 2 spawns (`vm_stat`, one batched `sysctl`), Linux 0 spawns
 * (three /proc reads). Called once per resource-monitor tick.
 */

/** Total RAM never changes while the app runs — read once, keep forever. */
let cachedTotalMemory: string | null = null;

/**
 * Run a command and return stdout, or "" on any failure. Stdout is drained
 * concurrently with awaiting exit — awaiting `exited` first deadlocks on a full
 * pipe buffer (same reason as port-scanner's runText).
 */
async function runText(cmd: string[]): Promise<string> {
	try {
		const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return "";
		return stdout;
	} catch {
		return "";
	}
}

async function readTextFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		// /proc/pressure/memory is absent on kernels built without PSI, and on
		// some WSL kernels — an expected miss, handled by the fallback classifier.
		return "";
	}
}

async function probeMac(): Promise<MemoryFacts | null> {
	if (cachedTotalMemory === null) {
		const total = (await runText(["sysctl", "-n", "hw.memsize"])).trim();
		if (!total) return null;
		cachedTotalMemory = total;
	}

	// One sysctl for both values; -n prints them in the requested order.
	const [vmStat, sysctlOut] = await Promise.all([
		runText(["vm_stat"]),
		runText(["sysctl", "-n", "vm.swapusage", "kern.memorystatus_vm_pressure_level"]),
	]);
	if (!vmStat) return null;

	const lines = sysctlOut.split("\n");
	return parseMacMemory(vmStat, cachedTotalMemory, lines[0] ?? "", lines[1] ?? "");
}

async function probeLinux(): Promise<MemoryFacts | null> {
	const [meminfo, psi, vmstat] = await Promise.all([
		readTextFile("/proc/meminfo"),
		readTextFile("/proc/pressure/memory"),
		readTextFile("/proc/vmstat"),
	]);
	if (!meminfo) return null;
	return parseLinuxMemory(meminfo, psi, vmstat);
}

/** Current platform memory facts, or null when the platform is unsupported or unreadable. */
export async function probeMemoryFacts(): Promise<MemoryFacts | null> {
	try {
		if (process.platform === "darwin") return await probeMac();
		if (process.platform === "linux") return await probeLinux();
		return null;
	} catch {
		return null;
	}
}
