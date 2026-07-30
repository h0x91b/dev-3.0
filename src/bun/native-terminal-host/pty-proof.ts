/**
 * The interactive shell the packaging pty tracer (`__host`) drives. It exists
 * only to prove a staged packaged image can open a real pty from the packaged
 * runtime; a product session never comes through here.
 */

import { join } from "node:path";

export interface ProofShellCommand {
	executable: string;
	args: string[];
}

export function powerShellInteractiveArgs(): string[] {
	return ["-NoLogo", "-NoProfile"];
}

/** Windows drives PowerShell from SystemRoot; macOS and Linux get a plain interactive `sh`. */
export function proofShellCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ProofShellCommand {
	if (platform !== "win32") return { executable: "/bin/sh", args: ["-i"] };
	const systemRoot = env.SystemRoot ?? env.WINDIR;
	if (!systemRoot) throw new Error("Packaged terminal host cannot resolve SystemRoot.");
	return {
		executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		args: powerShellInteractiveArgs(),
	};
}
