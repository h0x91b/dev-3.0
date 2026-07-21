import type { NativeTerminalHostProofState } from "../../shared/native-terminal-runtime";

function isBunExecutable(execPath: string): boolean {
	const parts = execPath.replaceAll("\\", "/").split("/");
	const name = parts[parts.length - 1]?.toLowerCase();
	return name === "bun" || name === "bun.exe";
}

export function requireLiveTerminalHostState(
	state: NativeTerminalHostProofState | null,
	isProcessAlive: (pid: number) => boolean,
): NativeTerminalHostProofState {
	if (!state) throw new Error("packaged terminal host state is missing");
	if (!isProcessAlive(state.hostPid)) throw new Error(`detached terminal host ${state.hostPid} is no longer running`);
	if (!isProcessAlive(state.shellPid)) throw new Error(`PowerShell ${state.shellPid} is no longer running`);
	return state;
}

export function computeTerminalHostReentryArgs(
	argv: string[],
	execPath: string,
	stagedEntrypoint?: string,
): string[] {
	if (stagedEntrypoint) return [stagedEntrypoint, "__host"];
	return isBunExecutable(execPath) ? [argv[1], "__host"] : ["__host"];
}
