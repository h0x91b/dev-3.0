/**
 * The remediation hint must match the cause. "Check the agent is installed" sent
 * a Windows user hunting a healthy agent while the real failure was a shell dev3
 * could not resolve, so the marker below is a contract between the thrower and
 * the renderer — not a nicety.
 */
import { describe, it, expect } from "vitest";
import { classifyLaunchFailure, launchFailureHintKey, SHELL_NOT_FOUND_MARKER } from "../../shared/launch-failure";
import { ShellExecutableNotFoundError } from "../native-terminal-registry/shell-launch";

describe("classifyLaunchFailure", () => {
	it("recognises the error the registry actually throws", () => {
		const message = new ShellExecutableNotFoundError("/bin/bash").message;
		expect(message).toContain(SHELL_NOT_FOUND_MARKER);
		expect(classifyLaunchFailure(message)).toBe("shell-not-found");
	});

	it("recognises it through the wrapping the spawn handler adds", () => {
		const wrapped = `Failed to spawn agent: splitView failed: ${SHELL_NOT_FOUND_MARKER}: /bin/bash`;
		expect(launchFailureHintKey(wrapped)).toBe("launch.failedLaunchHintShell");
	});

	it("leaves every other failure with the agent-install hint", () => {
		expect(launchFailureHintKey("Failed to spawn agent: claude: command not found")).toBe("launch.failedLaunchHint");
		expect(launchFailureHintKey("")).toBe("launch.failedLaunchHint");
		expect(launchFailureHintKey(null)).toBe("launch.failedLaunchHint");
	});
});
