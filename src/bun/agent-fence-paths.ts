/**
 * Where the agent-fence close requests live, kept apart from `agent-fence.ts` on purpose:
 * this module touches no filesystem, so the launch code can import it without every suite
 * that mocks `node:fs` by name having to learn about the fence.
 */

import { join } from "node:path";
import { DEV3_HOME } from "./paths";

/** The one flat directory every instance sweeps. New and additive under `~/.dev3.0`. */
export function agentFenceIndexDir(): string {
	return join(DEV3_HOME, "agent-fence");
}

/** Whether `binary` is dev3's own PATH shim, which a generated wrapper must never call. */
export function isDev3BinShim(binary: string): boolean {
	return binary.startsWith(`${join(DEV3_HOME, "bin")}/`);
}
