/**
 * Classification of a launch failure, so the UI's remediation hint matches the
 * actual cause instead of always blaming a missing agent binary.
 *
 * The error crosses RPC as a plain string, so the marker below is the contract
 * between the thrower (`ShellExecutableNotFoundError`) and the renderer. Both
 * sides import it from here — a reworded message can never silently drift.
 */

/** Substring present in every `ShellExecutableNotFoundError` message. */
export const SHELL_NOT_FOUND_MARKER = "requested shell executable not found";

export type LaunchFailureCause = "shell-not-found" | "unknown";

export function classifyLaunchFailure(errorText: string | null | undefined): LaunchFailureCause {
	return errorText?.includes(SHELL_NOT_FOUND_MARKER) ? "shell-not-found" : "unknown";
}

/** Translation key of the hint shown under a failed launch/spawn error. */
export function launchFailureHintKey(errorText: string | null | undefined): "launch.failedLaunchHint" | "launch.failedLaunchHintShell" {
	return classifyLaunchFailure(errorText) === "shell-not-found"
		? "launch.failedLaunchHintShell"
		: "launch.failedLaunchHint";
}
