function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function powerShellStartupArgs(marker: string): string[] {
	return ["-NoLogo", "-NoProfile", "-NoExit", "-Command", `Write-Output "${marker}:$PID"`];
}

export function extractPowerShellMarkerPid(output: string, marker: string): number | null {
	const pid = Number(new RegExp(`${escapeRegex(marker)}:(\\d+)`).exec(output)?.[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}
