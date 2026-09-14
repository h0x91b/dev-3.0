/**
 * omp's approval tiers, as data with no adapter imports, so the renderer's
 * command preview reads the very map the launcher uses. A wrong value is not
 * rejected by omp — it silently runs at its configured default, `yolo`.
 *
 * `plan` is deliberately absent: omp enters plan mode from its
 * `plan.defaultOnStartup` setting, not from a launch flag.
 */
export const OMP_APPROVAL_MODE: Partial<Record<string, string>> = {
	acceptEdits: "write",
	bypassPermissions: "yolo",
	dontAsk: "yolo",
};
