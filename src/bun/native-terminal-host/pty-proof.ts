import { Buffer } from "node:buffer";

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function powerShellStartupArgs(marker: string): string[] {
	const command = `Write-Output "${marker}:$PID"`;
	return ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

export function extractPowerShellMarkerPid(output: string, marker: string): number | null {
	const pid = Number(new RegExp(`${escapeRegex(marker)}:(\\d+)`).exec(output)?.[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}
