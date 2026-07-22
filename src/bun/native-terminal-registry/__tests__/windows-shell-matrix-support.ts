import { isProcessAlive } from "../process-identity";

interface ProcessExitWaitOptions {
	timeoutMs?: number;
	pollMs?: number;
	isAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export async function waitForProcessesToExit(
	pids: number[],
	opts: ProcessExitWaitOptions = {},
): Promise<number[]> {
	const isAlive = opts.isAlive ?? isProcessAlive;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = opts.now ?? Date.now;
	const pollMs = opts.pollMs ?? 50;
	const deadline = now() + (opts.timeoutMs ?? 8_000);
	let survivors: number[] = [];

	do {
		survivors = pids.filter((pid) => isAlive(pid));
		if (survivors.length === 0 || now() >= deadline) return survivors;
		await sleep(pollMs);
	} while (true);
}
