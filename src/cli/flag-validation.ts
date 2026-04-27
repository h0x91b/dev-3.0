import type { ParsedArgs } from "./args";
import { exitUsage } from "./output";

export function rejectUnknownFlags(args: ParsedArgs, allowed: readonly string[]): void {
	const allowedSet = new Set(allowed);
	const unknown = Object.keys(args.flags).filter((flag) => !allowedSet.has(flag));
	if (unknown.length === 0) return;

	const formatted = unknown.map((flag) => `--${flag}`).join(", ");
	exitUsage(`Unknown option${unknown.length === 1 ? "" : "s"}: ${formatted}`);
}
