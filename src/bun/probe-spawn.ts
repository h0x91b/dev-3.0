/**
 * Read-only system probes (`ps`, `vm_stat`, `sysctl`) run from the pollers.
 *
 * A probe whose child never exits — or whose pipe never closes — must not hold
 * its poller forever: the resource-monitor tick awaits these, and a tick that
 * never settles never schedules the next one. Bounded with the same helper the
 * tmux client uses, so a stuck child is TERMed, then KILLed, then abandoned.
 */
import { spawn } from "./spawn";
import { createLogger } from "./logger";
import { runBounded } from "./tmux/bounded-spawn";

const log = createLogger("probe-spawn");

/** Stdout of `cmd`, or "" on a spawn error, a non-zero exit, or a timeout. */
export async function runProbeText(cmd: string[], timeoutMs: number): Promise<string> {
	let outcome: Awaited<ReturnType<typeof runBounded>>;
	try {
		outcome = await runBounded(spawn(cmd, { stdout: "pipe", stderr: "pipe" }), { timeoutMs });
	} catch {
		return "";
	}
	if (outcome.kind === "stopped") {
		log.warn("System probe timed out and was stopped", { command: cmd[0], timeoutMs, confirmed: outcome.confirmed });
		return "";
	}
	return outcome.value.exitCode === 0 ? outcome.value.stdout : "";
}
