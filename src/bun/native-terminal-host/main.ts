import { spawn as spawnProcess } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "../spawn";
import {
	NATIVE_TERMINAL_HOST_READY_MARKER,
	assertNativeTerminalRuntime,
	nativeTerminalSpawnError,
	sameNativeTerminalPath,
	type NativeTerminalHostProofState,
} from "../../shared/native-terminal-runtime";
import { extractPowerShellMarkerPid } from "./pty-proof";
import { computeTerminalHostReentryArgs } from "./reentry";
import { resolvesWithin } from "./wait-with-timeout";

const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const stateDir = (): string => process.env.DEV3_TERMINAL_HOST_PROOF_DIR ?? "";
const stateFile = (): string => join(stateDir(), "state.json");
const stopFile = (): string => join(stateDir(), "stop");
const logFile = (): string => join(stateDir(), "host.log");

function requireStateDir(): string {
	const dir = stateDir();
	if (!dir) throw new Error("DEV3_TERMINAL_HOST_PROOF_DIR is required for the packaged host tracer.");
	return dir;
}

function readState(): NativeTerminalHostProofState | null {
	try {
		return JSON.parse(readFileSync(stateFile(), "utf8")) as NativeTerminalHostProofState;
	} catch {
		return null;
	}
}

function writeState(state: NativeTerminalHostProofState): void {
	const temp = `${stateFile()}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state)}\n`);
	renameSync(temp, stateFile());
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function logTail(): string {
	try {
		return readFileSync(logFile(), "utf8").trim().slice(-4000);
	} catch {
		return "";
	}
}

function removeProofFiles(): void {
	for (const path of [stopFile(), stateFile(), logFile()]) {
		try {
			unlinkSync(path);
		} catch {
			// already absent
		}
	}
	try {
		rmdirSync(stateDir());
	} catch {
		// keep a non-empty caller-owned directory
	}
}

async function runHost(): Promise<void> {
	requireStateDir();
	assertNativeTerminalRuntime({ platform: process.platform, bunVersion: Bun.version });
	const expectedExecutable = process.env.DEV3_EXPECT_HOST_EXECUTABLE;
	if (expectedExecutable && !sameNativeTerminalPath(process.execPath, expectedExecutable)) {
		throw new Error(`Detached host re-entered ${process.execPath}; expected ${expectedExecutable}.`);
	}
	const stagedEntrypoint = process.env.DEV3_TERMINAL_HOST_ENTRYPOINT;
	if (stagedEntrypoint && !sameNativeTerminalPath(process.argv[1], stagedEntrypoint)) {
		throw new Error(`Detached host re-entered ${process.argv[1]}; expected ${stagedEntrypoint}.`);
	}

	let ffiModuleAvailable = false;
	try {
		await import("bun:ffi");
		ffiModuleAvailable = true;
	} catch {
		// Containment may still use a signed helper; the proof reports this capability.
	}

	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot) throw new Error("Packaged terminal host cannot resolve SystemRoot.");
	const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (!existsSync(powershell)) throw new Error(`Packaged terminal host cannot find PowerShell at ${powershell}.`);

	const marker = `DEV3_HOST_POWERSHELL_${crypto.randomUUID().replaceAll("-", "")}`;
	let output = "";
	let captureStartup = true;
	let observeMarker: (() => void) | null = null;
	const markerSeen = new Promise<void>((resolveMarker) => {
		observeMarker = resolveMarker;
	});
	const decoder = new TextDecoder();
	const proc = (() => {
		try {
			return spawn([powershell, "-NoLogo", "-NoProfile"], {
				cwd: process.cwd(),
				env: { ...process.env, TERM: "xterm-256color" },
				terminal: {
					cols: 80,
					rows: 24,
					data(_terminal: unknown, bytes: Uint8Array) {
						if (!captureStartup) return;
						output = `${output}${decoder.decode(bytes, { stream: true })}`.slice(-8000);
						if (extractPowerShellMarkerPid(output, marker) !== null) observeMarker?.();
					},
				},
			});
		} catch (cause) {
			throw nativeTerminalSpawnError({
				platform: process.platform,
				bunVersion: Bun.version,
				command: powershell,
				cause,
			});
		}
	})();
	if (!proc.terminal) {
		try {
			proc.kill();
		} catch {
			// process already exited
		}
		throw nativeTerminalSpawnError({
			platform: process.platform,
			bunVersion: Bun.version,
			command: powershell,
			cause: new Error("Bun.spawn returned without a terminal handle"),
		});
	}

	proc.terminal.write(`Write-Output \"${marker}:$PID\"\r`);
	const startup = await resolvesWithin(markerSeen, 10_000);
	const powershellPid = extractPowerShellMarkerPid(output, marker);
	captureStartup = false;
	if (!startup || powershellPid !== proc.pid) {
		proc.kill();
		throw new Error(
			`Packaged Bun ${Bun.version} did not start the expected PowerShell through Bun.Terminal ` +
				`(spawned ${proc.pid}, observed ${powershellPid ?? "no PID"}). ` +
				`Transcript: ${JSON.stringify(output.slice(-2000))}`,
		);
	}

	writeState({
		marker: NATIVE_TERMINAL_HOST_READY_MARKER,
		bunVersion: Bun.version,
		hostPid: process.pid,
		shellPid: powershellPid,
		executable: process.execPath,
		entrypoint: process.argv[1],
		ffiModuleAvailable,
	});

	while (!existsSync(stopFile())) {
		if (!isProcessAlive(proc.pid)) throw new Error("PowerShell exited before the detached host stop request.");
		await delay(50);
	}

	try {
		proc.terminal.write("\x03");
		await delay(75);
		proc.terminal.write("exit\r");
	} catch {
		// terminal already closed
	}
	const exited = await resolvesWithin(proc.exited, 3000);
	if (!exited) {
		proc.kill();
		await resolvesWithin(proc.exited, 1000);
	}
	try {
		proc.terminal.close();
	} catch {
		// terminal already closed
	}
}

async function start(): Promise<void> {
	const dir = requireStateDir();
	const existing = readState();
	if (existing && isProcessAlive(existing.hostPid)) {
		throw new Error(`packaged terminal host is already running (pid ${existing.hostPid})`);
	}
	mkdirSync(dir, { recursive: true });
	for (const path of [stateFile(), stopFile()]) {
		try {
			unlinkSync(path);
		} catch {
			// already absent
		}
	}

	const logFd = openSync(logFile(), "a");
	const child = spawnProcess(
		process.execPath,
		computeTerminalHostReentryArgs(process.argv, process.execPath, process.env.DEV3_TERMINAL_HOST_ENTRYPOINT),
		{
			cwd: process.cwd(),
			detached: true,
			env: { ...process.env },
			stdio: ["ignore", logFd, logFd],
		},
	);
	let exited = false;
	let earlyError = "";
	child.on("error", (error) => {
		exited = true;
		earlyError = error.message;
	});
	child.on("exit", () => {
		exited = true;
	});
	child.unref();

	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const state = readState();
		if (state && state.hostPid === child.pid && isProcessAlive(state.shellPid)) {
			closeSync(logFd);
			process.stdout.write(`${JSON.stringify(state)}\n`);
			return;
		}
		if (exited) {
			closeSync(logFd);
			const details = [earlyError, logTail()].filter(Boolean).join("\n");
			throw new Error(`detached terminal host exited during re-entry${details ? `:\n${details}` : ""}`);
		}
		await delay(50);
	}
	closeSync(logFd);
	throw new Error(`detached terminal host did not report readiness. ${logTail()}`);
}

async function stop(): Promise<void> {
	requireStateDir();
	const state = readState();
	if (!state) throw new Error("packaged terminal host state is missing");
	writeFileSync(stopFile(), "stop\n");
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (!isProcessAlive(state.hostPid) && !isProcessAlive(state.shellPid)) {
			process.stdout.write(`${JSON.stringify({ stopped: true, hostPid: state.hostPid, shellPid: state.shellPid })}\n`);
			removeProofFiles();
			return;
		}
		await delay(50);
	}
	throw new Error(`packaged terminal host did not stop cleanly (host ${state.hostPid}, shell ${state.shellPid})`);
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === "version") {
		const entrypoint = process.argv[1];
		process.stdout.write(
			`${JSON.stringify({
				bunVersion: Bun.version,
				executable: process.execPath,
				entrypoint,
				carrier: entrypoint.replaceAll("\\", "/").includes("/$bunfs/") ? "compiled" : "bun-runtime-script",
			})}\n`,
		);
		return;
	}
	if (command === "start") return start();
	if (command === "stop") return stop();
	if (command === "__host") return runHost();
	throw new Error("usage: dev3-terminal-host version|start|stop");
}

void main().catch((error) => {
	process.stderr.write(`terminal host error: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
