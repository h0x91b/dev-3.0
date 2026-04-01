import { spawn, spawnSync } from "./spawn";

async function whichNodeAsync(command: string): Promise<string | null> {
	const lookup = process.platform === "win32"
		? ["where.exe", command]
		: ["which", command];
	const proc = spawn(lookup, {
		stdout: "pipe",
		stderr: "ignore",
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0 || !stdout.trim()) {
		return null;
	}
	const lines = stdout.trim().split(/\r?\n/);
	return lines[0] || null;
}

function whichNodeSync(command: string): string | null {
	const lookup = process.platform === "win32"
		? ["where.exe", command]
		: ["which", command];
	const result = spawnSync(lookup, {
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0 || !result.stdout) {
		return null;
	}
	const output = new TextDecoder().decode(result.stdout).trim();
	if (!output) {
		return null;
	}
	const lines = output.split(/\r?\n/);
	return lines[0] || null;
}

const bunWhich =
	typeof Bun !== "undefined" && typeof Bun.which === "function"
		? Bun.which
		: null;

export const which: (command: string) => Promise<string | null> = bunWhich
	? async (command) => bunWhich(command)
	: whichNodeAsync;

export const whichSync: (command: string) => string | null = bunWhich
	? bunWhich
	: whichNodeSync;
