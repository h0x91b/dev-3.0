import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_TERMINAL_HOST_READY_MARKER, type NativeTerminalHostProofState } from "../../../shared/native-terminal-runtime";
import { extractPowerShellMarkerPid, powerShellStartupArgs } from "../pty-proof";
import { computeTerminalHostReentryArgs, requireLiveTerminalHostState } from "../reentry";
import { resolvesWithin } from "../wait-with-timeout";

afterEach(() => vi.useRealTimers());

describe("native terminal host detached re-entry", () => {
	const state: NativeTerminalHostProofState = {
		marker: NATIVE_TERMINAL_HOST_READY_MARKER,
		bunVersion: "1.3.14",
		hostPid: 101,
		shellPid: 202,
		executable: "C:\\staged\\dev3-terminal-host.exe",
		entrypoint: "C:\\staged\\dev3-terminal-host.js",
		ffiModuleAvailable: true,
	};

	it("re-enters a compiled host without forwarding Bun's virtual entrypoint", () => {
		expect(
			computeTerminalHostReentryArgs(
				["C:\\app\\dev3-terminal-host.exe", "/$bunfs/root/main.js", "start"],
				"C:\\app\\dev3-terminal-host.exe",
			),
		).toEqual(["__host"]);
	});

	it("re-enters a source host through the current Bun and entry script", () => {
		expect(
			computeTerminalHostReentryArgs(
				["C:\\bun\\bun.exe", "C:\\repo\\src\\bun\\native-terminal-host\\main.ts", "start"],
				"C:\\bun\\bun.exe",
			),
		).toEqual(["C:\\repo\\src\\bun\\native-terminal-host\\main.ts", "__host"]);
	});

	it("re-enters through an explicitly staged script when the Bun runtime is renamed", () => {
		expect(
			computeTerminalHostReentryArgs(
				["C:\\staged\\dev3-terminal-host.exe", "C:\\staged\\dev3-terminal-host.js", "start"],
				"C:\\staged\\dev3-terminal-host.exe",
				"C:\\staged\\dev3-terminal-host.js",
			),
		).toEqual(["C:\\staged\\dev3-terminal-host.js", "__host"]);
	});

	it("reattaches to the same live host and PowerShell process", () => {
		expect(requireLiveTerminalHostState(state, () => true)).toBe(state);
	});

	it("rejects reattach when either process has exited", () => {
		expect(() => requireLiveTerminalHostState(state, (pid) => pid === state.hostPid)).toThrow(
			"PowerShell 202 is no longer running",
		);
		expect(() => requireLiveTerminalHostState(state, (pid) => pid === state.shellPid)).toThrow(
			"host 101 is no longer running",
		);
	});
});

describe("PowerShell PTY readiness marker", () => {
	it("emits the marker from the startup command before interactive input", () => {
		const marker = "DEV3_HOST_POWERSHELL_abc";
		expect(powerShellStartupArgs(marker)).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NoExit",
			"-Command",
			`Write-Output "${marker}:$PID"`,
		]);
	});

	it("ignores the echoed command until PowerShell expands its PID", () => {
		const marker = "DEV3_HOST_POWERSHELL_abc";
		expect(extractPowerShellMarkerPid(`Write-Output \"${marker}:$PID\"`, marker)).toBeNull();
		expect(extractPowerShellMarkerPid(`Write-Output \"${marker}:$PID\"\r\n${marker}:4242`, marker)).toBe(4242);
	});
});

describe("detached host bounded waits", () => {
	it("clears the timeout when the observed operation resolves first", async () => {
		vi.useFakeTimers();
		await expect(resolvesWithin(Promise.resolve(), 10_000)).resolves.toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns false when the deadline wins", async () => {
		vi.useFakeTimers();
		const result = resolvesWithin(new Promise<void>(() => {}), 100);
		await vi.advanceTimersByTimeAsync(100);
		await expect(result).resolves.toBe(false);
	});
});
