import { win32 as pathWin32 } from "node:path";

export const NATIVE_SESSION_LAUNCH_ENV = "DEV3_NATIVE_SESSION_LAUNCH" as const;

export interface ShellLaunchSpec {
	executable: string;
	argv: string[];
	cwd: string;
	/** Environment overrides applied on top of the host environment. */
	env: Record<string, string>;
}

function invalidLaunchSpec(): never {
	throw new Error("invalid shell launch specification");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function defineShellLaunchSpec(spec: ShellLaunchSpec): ShellLaunchSpec {
	if (!isRecord(spec) || typeof spec.executable !== "string" || !spec.executable.trim()) invalidLaunchSpec();
	if (!Array.isArray(spec.argv) || !spec.argv.every((arg) => typeof arg === "string")) invalidLaunchSpec();
	if (typeof spec.cwd !== "string" || !spec.cwd.trim()) invalidLaunchSpec();
	if (!isRecord(spec.env) || !Object.values(spec.env).every((value) => typeof value === "string")) invalidLaunchSpec();
	return {
		executable: spec.executable,
		argv: [...spec.argv],
		cwd: spec.cwd,
		env: { ...spec.env },
	};
}

export function encodeShellLaunchSpec(spec: ShellLaunchSpec): string {
	return JSON.stringify(defineShellLaunchSpec(spec));
}

export function decodeShellLaunchSpec(raw: string): ShellLaunchSpec {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return invalidLaunchSpec();
	}
	if (!isRecord(parsed)) return invalidLaunchSpec();
	return defineShellLaunchSpec(parsed as unknown as ShellLaunchSpec);
}

export function shellCommand(spec: ShellLaunchSpec): string[] {
	return [spec.executable, ...spec.argv];
}

export class ShellExecutableNotFoundError extends Error {
	readonly code = "executable-not-found" as const;

	constructor(readonly executable: string) {
		super(`requested shell executable not found: ${executable}`);
		this.name = "ShellExecutableNotFoundError";
	}
}

export type ShellExecutableResolver = (executable: string, spec: ShellLaunchSpec) => string | null;

export function resolveShellLaunchSpec(
	spec: ShellLaunchSpec,
	resolveExecutable: ShellExecutableResolver,
): ShellLaunchSpec {
	const launch = defineShellLaunchSpec(spec);
	const executable = resolveExecutable(launch.executable, launch);
	if (!executable) throw new ShellExecutableNotFoundError(launch.executable);
	return { ...launch, executable };
}

export type ShellExitVerdict =
	| { kind: "success"; code: 0 }
	| { kind: "shell-command-failed"; code: number }
	| { kind: "terminated-without-exit-code"; code: null };

export function shellExitVerdict(code: number | null): ShellExitVerdict {
	if (code === null) return { kind: "terminated-without-exit-code", code };
	if (code === 0) return { kind: "success", code };
	return { kind: "shell-command-failed", code };
}

export type RequiredWindowsShell = "windows-powershell-5.1" | "powershell-7" | "cmd";

interface WindowsShellLaunchOptions {
	executable: string;
	cwd: string;
	env: Record<string, string>;
}

export function windowsShellLaunchSpec(
	shell: RequiredWindowsShell,
	options: WindowsShellLaunchOptions,
): ShellLaunchSpec {
	let argv: string[];
	switch (shell) {
		case "cmd":
			argv = ["/D", "/Q", "/V:OFF"];
			break;
		case "windows-powershell-5.1":
		case "powershell-7":
			argv = ["-NoLogo", "-NoProfile", "-NoExit"];
			break;
		default:
			throw new Error(`unsupported Windows shell: ${String(shell)}`);
	}
	return defineShellLaunchSpec({
		executable: options.executable,
		argv,
		cwd: options.cwd,
		env: options.env,
	});
}

interface DefaultNativeShellOptions {
	platform: NodeJS.Platform;
	cwd: string;
	env: Record<string, string | undefined>;
}

export function defaultNativeShellLaunchSpec(options: DefaultNativeShellOptions): ShellLaunchSpec {
	if (options.platform === "win32") {
		const systemRoot = options.env.SystemRoot ?? options.env.SYSTEMROOT ?? options.env.WINDIR;
		if (!systemRoot) throw new Error("SystemRoot is required to select Windows PowerShell 5.1");
		return windowsShellLaunchSpec("windows-powershell-5.1", {
			executable: pathWin32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			cwd: options.cwd,
			env: {},
		});
	}
	return defineShellLaunchSpec({
		executable: options.env.SHELL || "/bin/bash",
		argv: [],
		cwd: options.cwd,
		env: {},
	});
}
