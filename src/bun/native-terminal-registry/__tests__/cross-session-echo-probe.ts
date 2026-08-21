#!/usr/bin/env bun
/**
 * Controlled experiment for the intermittent "bravo journal holds only bravo's
 * output" failure of the lifecycle E2E (seq 1550): does one session's marker
 * reach another session's OUTPUT STREAM at all, with dev3 removed from the
 * picture?
 *
 * Two shells are started in THIS process, each on its own Bun terminal — no
 * registry, no host, no journal, no fan-out. Whatever crosses here crossed
 * inside the shell or the operating system, so a hit exonerates the product and
 * a clean run puts the fault back into dev3's own path.
 *
 * Arm A runs the shells exactly as the E2E does (shared user profile). Arm B
 * gives each shell a private profile, which on Windows is what decides whether
 * PSReadLine's history file — one file per user, shared by every PowerShell on
 * the machine — is a channel between them.
 *
 * Run: `bun run test:native-cross-session-echo` (DEV3_ECHO_PROBE_ROUNDS=n).
 */

import { mkdirSync, mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "../../spawn";
import { defaultNativeShellLaunchSpec, type ShellLaunchSpec } from "../shell-launch";

const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";
const rounds = Number(process.env.DEV3_ECHO_PROBE_ROUNDS ?? "8") || 8;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Printable single-line excerpt of raw PTY bytes, escapes included. */
function excerpt(text: string, max = 400): string {
	let out = "";
	for (const ch of text.slice(-max)) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
	}
	return out;
}

/** The bytes AROUND a foreign marker — the only thing that names how it arrived. */
function context(text: string, needle: string, radius = 300): string {
	const at = text.indexOf(needle);
	if (at < 0) return "";
	return excerpt(text.slice(Math.max(0, at - radius), at + needle.length + radius), 2 * radius + needle.length);
}

interface Shell {
	write(data: string): void;
	text(): string;
	stop(): void;
}

function startShell(launch: ShellLaunchSpec, envOverride: Record<string, string>): Shell {
	let buf = "";
	const dec = new TextDecoder();
	const proc = spawn([launch.executable, ...launch.argv], {
		terminal: {
			cols: 120,
			rows: 30,
			data(_terminal: unknown, bytes: Uint8Array) {
				buf += dec.decode(bytes, { stream: true });
			},
		},
		cwd: launch.cwd,
		env: { ...process.env, TERM: "xterm-256color", ...launch.env, ...envOverride },
	});
	if (!proc.terminal) throw new Error("Bun.spawn returned without a terminal handle");
	const terminal = proc.terminal;
	return {
		write: (data) => terminal.write(data),
		text: () => buf,
		stop: () => {
			try {
				terminal.close();
			} catch {
				// already closed
			}
			try {
				proc.kill();
			} catch {
				// already exited
			}
		},
	};
}

async function waitFor(shell: Shell, needle: string, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (shell.text().includes(needle)) return true;
		await delay(30);
	}
	return false;
}

interface RoundResult {
	crossed: boolean;
	ownSeen: boolean;
	context: string;
}

/**
 * One round: shell ONE emits its marker, then shell TWO emits its own. A round is
 * a hit when shell TWO's stream carries shell ONE's marker.
 */
async function round(index: number, isolateProfiles: boolean, startTwoLate: boolean): Promise<RoundResult> {
	const root = mkdtempSync(join(tmpdir(), "dev3-echo-probe-"));
	const launch = isWindows
		? defaultNativeShellLaunchSpec({ platform: process.platform, cwd: root, env: process.env })
		: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd: root, env: {} };
	const nonce = `n${Date.now()}${index}`;
	const oneMark = `ONEMARK:${nonce}`;
	const twoMark = `TWOMARK:${nonce}`;
	const profileEnv = (name: string): Record<string, string> => {
		if (!isolateProfiles) return {};
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		// PSReadLine resolves its single history file under APPDATA; HOME does the
		// same job for a POSIX shell. Splitting them is the whole variable under test.
		return isWindows ? { APPDATA: dir, LOCALAPPDATA: dir } : { HOME: dir };
	};

	const emit = (shell: Shell, mark: string): void =>
		shell.write(isWindows ? `Write-Output "${mark}"${lineEnd}` : `echo "${mark}"${lineEnd}`);
	const one = startShell(launch, profileEnv("profile-one"));
	// The order is a variable, not a detail: the suspected channel is a history file
	// read when a line editor STARTS, so a shell that started before the other's line
	// was accepted cannot see it, and a shell started after must.
	let two: Shell | null = startTwoLate ? null : startShell(launch, profileEnv("profile-two"));
	try {
		for (let attempt = 0; attempt < 8; attempt++) {
			emit(one, oneMark);
			if (await waitFor(one, oneMark, 2000)) break;
		}
		const oneSeen = one.text().includes(oneMark);
		if (!two) two = startShell(launch, profileEnv("profile-two"));
		for (let attempt = 0; attempt < 8; attempt++) {
			emit(two, twoMark);
			if (await waitFor(two, twoMark, 2000)) break;
		}
		const twoText = two.text();
		return {
			crossed: twoText.includes(oneMark),
			ownSeen: oneSeen && twoText.includes(twoMark),
			context: context(twoText, oneMark),
		};
	} finally {
		one.stop();
		two?.stop();
	}
}

/** What the platform itself says about the suspected channel, before any round runs. */
function reportEnvironment(): void {
	console.log(`platform=${process.platform} bun=${Bun.version} rounds=${rounds}`);
	if (!isWindows) return;
	const ps = spawnSync([
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		[
			"$m = Get-Module -ListAvailable PSReadLine | Sort-Object Version -Descending | Select-Object -First 1",
			'Write-Output ("psreadline=" + $m.Version)',
			"$o = Get-PSReadLineOption",
			'Write-Output ("predictionSource=" + $o.PredictionSource)',
			'Write-Output ("historySaveStyle=" + $o.HistorySaveStyle)',
			'Write-Output ("historyFile=" + $o.HistorySavePath)',
		].join("; "),
	]);
	console.log(new TextDecoder().decode(ps.stdout).trim() || "psreadline query failed");
	const historyFile = join(
		process.env.APPDATA ?? "",
		"Microsoft",
		"Windows",
		"PowerShell",
		"PSReadLine",
		"ConsoleHost_history.txt",
	);
	console.log(`historyFileExists=${existsSync(historyFile)} bytes=${existsSync(historyFile) ? statSync(historyFile).size : -1}`);
}

async function arm(label: string, isolateProfiles: boolean, startTwoLate: boolean): Promise<number> {
	let hits = 0;
	let usable = 0;
	for (let i = 0; i < rounds; i++) {
		const result = await round(i, isolateProfiles, startTwoLate);
		if (result.ownSeen) usable++;
		if (result.crossed) {
			hits++;
			console.log(`  ${label} round ${i}: CROSSED — shell two's stream carries shell one's marker`);
			console.log(`    context: "${result.context}"`);
		} else {
			console.log(`  ${label} round ${i}: clean (own markers seen: ${result.ownSeen})`);
		}
	}
	console.log(`${label}: ${hits}/${rounds} crossed, ${usable}/${rounds} rounds had both markers`);
	return hits;
}

/**
 * PSReadLine's options as the LIVE interactive shell has them. A `-NonInteractive`
 * query answers for a host that never loaded the line editor, which is how the
 * first run of this probe came back with prediction reported off while the real
 * session was rendering predictions.
 */
async function reportInteractivePrediction(): Promise<void> {
	if (!isWindows) return;
	const root = mkdtempSync(join(tmpdir(), "dev3-echo-probe-opt-"));
	const launch = defaultNativeShellLaunchSpec({ platform: process.platform, cwd: root, env: process.env });
	const shell = startShell(launch, {});
	try {
		for (let attempt = 0; attempt < 8; attempt++) {
			shell.write(
				`Write-Output "interactive predictionSource=$((Get-PSReadLineOption).PredictionSource) view=$((Get-PSReadLineOption).PredictionViewStyle)"${lineEnd}`,
			);
			if (await waitFor(shell, "interactive predictionSource=", 2000)) break;
		}
		const line = shell
			.text()
			.split(/\r?\n/)
			.find((l) => l.includes("interactive predictionSource=") && !l.includes("Get-PSReadLineOption"));
		console.log(line?.trim() ?? "interactive PSReadLine query produced no answer");
	} finally {
		shell.stop();
	}
}

async function main(): Promise<void> {
	reportEnvironment();
	await reportInteractivePrediction();
	console.log("ARM A1 — shared profile, shell two started AFTER shell one's line was accepted");
	const sharedLate = await arm("A1", false, true);
	console.log("ARM A2 — shared profile, both shells started up front, as the lifecycle E2E does");
	const shared = await arm("A2", false, false);
	console.log("ARM B — private profile each, shell two started late (the A1 conditions, one variable off)");
	const isolated = await arm("B", true, true);
	const historyFile = isWindows
		? join(process.env.APPDATA ?? "", "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt")
		: "";
	if (historyFile && existsSync(historyFile)) {
		const text = readFileSync(historyFile, "utf8");
		const marks = text.split("\n").filter((line) => line.includes("ONEMARK:") || line.includes("TWOMARK:"));
		console.log(`shared history file recorded ${marks.length} probe command(s); last: ${marks[marks.length - 1] ?? "none"}`);
	}
	console.log(
		`VERDICT sharedLateStartHits=${sharedLate} sharedEarlyStartHits=${shared} privateProfileHits=${isolated} (of ${rounds} rounds each)`,
	);
}

await main();
