/**
 * The start signature that pins a message to one agent PROCESS: a recycled pid
 * never matches it. Linux reads the boot id and the start tick from `/proc`,
 * because `ps lstart` is boot time plus that tick, and the boot time moves with
 * every wall-clock step (WSL shifts it by seconds per minute). Why:
 * decisions/2026/10/27/agent-signature-from-proc-start-tick.md.
 */

import { readFile } from "node:fs/promises";
import { spawn } from "./spawn";

const LINUX_PREFIX = "linux:";

/** `pid@<ps lstart>`, or "" when the process is gone. */
async function readLstartSignature(pid: number): Promise<string> {
	try {
		const proc = spawn(["ps", "-p", String(pid), "-o", "lstart="], { stdout: "pipe", stderr: "ignore" });
		const [raw, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const start = raw.trim().replace(/\s+/g, " ");
		return exitCode === 0 && start ? `${pid}@${start}` : "";
	} catch {
		return "";
	}
}

/** `pid@linux:<boot id>:<start tick>`, or "" when the process is gone. */
async function readLinuxSignature(pid: number): Promise<string> {
	try {
		const [stat, bootId] = await Promise.all([
			readFile(`/proc/${pid}/stat`, "utf8"),
			readFile("/proc/sys/kernel/random/boot_id", "utf8"),
		]);
		// The command name in parentheses may hold spaces; field 22 counts from the pid.
		const startTick = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
		const boot = bootId.trim();
		return /^\d+$/.test(startTick) && boot ? `${pid}@${LINUX_PREFIX}${boot}:${startTick}` : "";
	} catch {
		return "";
	}
}

/** The signature of `pid` now, "" when it is gone. */
export async function readAgentProcessSignature(pid: number): Promise<string> {
	if (!Number.isInteger(pid) || pid <= 0) return "";
	return process.platform === "linux" ? readLinuxSignature(pid) : readLstartSignature(pid);
}

/**
 * Is the process `signature` was taken from still running? A signature stored in
 * the `lstart` form (an older build, or another platform) is read back the same way.
 */
export async function isSameAgentProcess(signature: string): Promise<boolean> {
	const pid = Number.parseInt(signature.split("@")[0] ?? "", 10);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const linuxForm = signature.slice(signature.indexOf("@") + 1).startsWith(LINUX_PREFIX);
	const current = linuxForm ? await readLinuxSignature(pid) : await readLstartSignature(pid);
	return current !== "" && current === signature;
}
