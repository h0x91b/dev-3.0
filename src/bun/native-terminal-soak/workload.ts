/**
 * Deterministic agent-like terminal workloads for the native-session soak
 * (seq 1301).
 *
 * The soak must reproduce what a coding agent actually does to a PTY —
 * alt-screen panels, SGR-coloured streaming lines, carriage-return spinner
 * redraws — WITHOUT any credentials, network access, or a real agent binary.
 * Every burst is a pure function of its shape plus a caller-chosen tag, so two
 * runs with the same shape emit byte-identical output and the harness can wait
 * on an exact completion marker instead of sleeping.
 *
 * Pure by design (no Bun, no fs): the shape/quoting logic is unit-tested under
 * vitest, while `run-soak.ts` feeds the command into a live shell.
 */

/** Prefix of the line every burst prints last; the tag makes each burst unique. */
export const SOAK_DONE_PREFIX = "DEV3-SOAK-DONE-";

/** Fixed-width filler so a burst's byte volume is a function of its shape alone. */
const PAYLOAD = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwx";

export interface SoakWorkloadShape {
	/** Streaming "token" lines — the scrolling bulk of the output. */
	lines: number;
	/** Alt-screen panel repaints — exercises buffer switching and absolute cursor moves. */
	panelRepaints: number;
	/** Carriage-return spinner frames — exercises identical-ish redraw coalescing. */
	spinnerFrames: number;
}

/**
 * The sustained burst deliberately emits MORE lines than the host's live-parser
 * scrollback limit (1000), so the parser core reaches its saturated steady state
 * before any per-cycle memory sample is taken. Without that, every reconnect
 * cycle would measure the scrollback still filling up and report a bounded
 * warm-up ramp as if it were an unbounded leak.
 */
export const DEFAULT_SOAK_WORKLOAD: SoakWorkloadShape = { lines: 1_400, panelRepaints: 120, spinnerFrames: 300 };

/** A short burst used for reconnect/churn probes where volume is not the point. */
export const SHORT_SOAK_WORKLOAD: SoakWorkloadShape = { lines: 40, panelRepaints: 12, spinnerFrames: 30 };

export function doneMarker(tag: string): string {
	return `${SOAK_DONE_PREFIX}${tag}`;
}

function assertSafeTag(tag: string): void {
	if (!/^[A-Za-z0-9-]{1,48}$/.test(tag)) {
		throw new Error(`unsafe soak tag ${JSON.stringify(tag)} — allowed: [A-Za-z0-9-]{1,48}`);
	}
}

function assertSaneShape(shape: SoakWorkloadShape): void {
	for (const [key, value] of Object.entries(shape)) {
		if (!Number.isInteger(value) || value < 0 || value > 100_000) {
			throw new Error(`soak workload ${key} must be an integer in [0, 100000], got ${String(value)}`);
		}
	}
}

/**
 * Bytes the burst is expected to push through the PTY, ignoring the shell's own
 * echo and prompt. Used to size evidence, never as a pass/fail assertion.
 */
export function approximateWorkloadBytes(shape: SoakWorkloadShape): number {
	const lineBytes = shape.lines * (PAYLOAD.length + 24);
	const panelBytes = shape.panelRepaints * 32;
	const spinnerBytes = shape.spinnerFrames * 26;
	return lineBytes + panelBytes + spinnerBytes;
}

function posixWorkload(shape: SoakWorkloadShape, tag: string): string {
	const { lines, panelRepaints, spinnerFrames } = shape;
	return [
		`printf '\\033[?1049h\\033[2J\\033[H'`,
		`r=0; while [ $r -lt ${panelRepaints} ]; do printf '\\033[1;1H\\033[7m panel %s \\033[0m' "$r"; r=$((r+1)); done`,
		`printf '\\033[?1049l'`,
		`i=0; while [ $i -lt ${lines} ]; do printf '\\033[36m|\\033[0m tok-%s %s\\n' "$i" '${PAYLOAD}'; i=$((i+1)); done`,
		`s=0; while [ $s -lt ${spinnerFrames} ]; do printf '\\r\\033[33mworking\\033[0m %s' "$s"; s=$((s+1)); done`,
		`printf '\\n%s\\n' '${doneMarker(tag)}'`,
	].join("; ");
}

function windowsWorkload(shape: SoakWorkloadShape, tag: string): string {
	const { lines, panelRepaints, spinnerFrames } = shape;
	// Windows PowerShell 5.1 has no "`e" escape, so ESC comes from [char]27.
	return [
		`$e=[char]27`,
		`Write-Host -NoNewline "$e[?1049h$e[2J$e[H"`,
		`for($r=0;$r -lt ${panelRepaints};$r++){Write-Host -NoNewline "$e[1;1H$e[7m panel $r $e[0m"}`,
		`Write-Host -NoNewline "$e[?1049l"`,
		`for($i=0;$i -lt ${lines};$i++){Write-Host "$e[36m|$e[0m tok-$i ${PAYLOAD}"}`,
		`for($s=0;$s -lt ${spinnerFrames};$s++){Write-Host -NoNewline "\`r$e[33mworking$e[0m $s"}`,
		`Write-Host ""`,
		`Write-Host "${doneMarker(tag)}"`,
	].join("; ");
}

/** One shell command line that emits the whole burst and ends with the marker. */
export function soakWorkloadCommand(
	shape: SoakWorkloadShape,
	tag: string,
	platform: NodeJS.Platform = process.platform,
): string {
	assertSafeTag(tag);
	assertSaneShape(shape);
	return platform === "win32" ? windowsWorkload(shape, tag) : posixWorkload(shape, tag);
}

/** Spawn one nested interactive shell inside the session's root shell. */
export function nestedShellCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "powershell.exe -NoLogo -NoProfile" : "bash --norc --noprofile";
}

/** Print the current shell's own PID under a parseable marker. */
export function reportPidCommand(label: string, platform: NodeJS.Platform = process.platform): string {
	assertSafeTag(label);
	return platform === "win32" ? `Write-Output "${label}[$PID]"` : `echo "${label}[$$]"`;
}

/**
 * Keep the current shell BUSY in the foreground, emitting output, until it is
 * killed. This is what a crash during real agent work looks like, and it is the
 * only shape in which POSIX signal propagation is observable: a shell sitting
 * idle at a prompt sees the hangup as plain EOF and exits normally, which does
 * NOT hup its background jobs (proved by this soak — decision 172).
 */
export function busyForegroundCommand(label: string, platform: NodeJS.Platform = process.platform): string {
	assertSafeTag(label);
	if (platform === "win32") return `while ($true) { Write-Output "${label}:$PID"; Start-Sleep -Milliseconds 5 }`;
	return `while :; do printf '${label}:%s\\n' "$$"; for j in 1 2 3 4 5 6 7 8 9 10; do :; done; sleep 0.01; done`;
}

/** Detach a long-lived grandchild from the current shell and report its PID. */
export function longLivedGrandchildCommands(
	label: string,
	seconds: number,
	platform: NodeJS.Platform = process.platform,
): string[] {
	assertSafeTag(label);
	if (platform === "win32") {
		return [
			`$g = Start-Process -PassThru powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds ${seconds}'); Write-Output "${label}[$($g.Id)]"`,
		];
	}
	return ["set +H", `sleep ${seconds} &`, `echo "${label}[$!]"`];
}
