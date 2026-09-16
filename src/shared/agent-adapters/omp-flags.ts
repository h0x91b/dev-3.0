/**
 * omp's approval tier for each dev3 permission mode, as data with no adapter
 * imports so the renderer's command preview reads the very map the launcher
 * uses.
 *
 * The map is total, `default` included, because omp never asks when the flag
 * is absent: it runs at its configured `tools.approvalMode`, which upstream
 * ships as `yolo`, and it swallows an unknown value the same way. Every other
 * CLI treats "no flag" as "ask me", so the modes without a tier of their own
 * fail closed to `always-ask` rather than open. `plan` has no tier: omp enters
 * plan mode from its `plan.defaultOnStartup` setting, not from a launch flag.
 * Typed on `PermissionMode` so a new mode is a compile error here, not a
 * silent `yolo` session.
 */
import type { PermissionMode } from "../types";

export type OmpApprovalMode = "always-ask" | "write" | "yolo";

export const OMP_APPROVAL_MODE: Record<PermissionMode, OmpApprovalMode> = {
	default: "always-ask",
	plan: "always-ask",
	auto: "always-ask",
	acceptEdits: "write",
	bypassPermissions: "yolo",
	dontAsk: "yolo",
};

/** Whether a preset's own args already carry `flag`, as `--x v` or `--x=v`. */
export function hasOmpFlag(args: readonly string[] | undefined, flag: string): boolean {
	return args?.some((a) => a === flag || a.startsWith(`${flag}=`)) ?? false;
}
