/**
 * The orphan/leak verdicts and the runtime table for the live terminal e2e CI gate
 * (seq 1422). Pure, so the gate itself is unit-tested: a guard that silently stops
 * detecting is indistinguishable from a clean run, which is the whole failure mode
 * this gate exists to remove.
 *
 * The runner shell lives in `scripts/run-terminal-e2e.ts`.
 */

/**
 * `fast` exists so narrowing the gate is a one-word change with a visible name,
 * never a silent deletion. Every script is `fast` today because the whole set
 * measures well under a minute; move one to `full` only with a measured reason.
 */
export type E2eTier = "fast" | "full";

export interface E2eScript {
	/** `package.json` script name, minus the `test:` prefix. */
	readonly name: string;
	readonly tier: E2eTier;
	/** What only a live tmux server or a live native host can prove here. */
	readonly proves: string;
}

export const TERMINAL_E2E_SCRIPTS: readonly E2eScript[] = [
	{ name: "tmux-guarded-send-e2e", tier: "fast", proves: "guard grammar + recycled pane ids on a live tmux server" },
	{ name: "pane-input-owner-e2e", tier: "fast", proves: "exactly-once pane input across three real processes" },
	{ name: "pane-input-native-e2e", tier: "fast", proves: "writer-lease binding against a real native host" },
	{ name: "native-registry-e2e", tier: "fast", proves: "detached host survives its launcher; token-matched cleanup" },
	{ name: "native-owner-routing-e2e", tier: "fast", proves: "cross-process routing never invokes tmux" },
	{ name: "native-multipane-e2e", tier: "fast", proves: "multi-pane lifecycle tears down every owned process tree" },
	{ name: "native-message-e2e", tier: "fast", proves: "CLI message delivery leaves the tmux surface byte-identical" },
];

/**
 * Looks like this suite: a throwaway root, a guarded-send socket, or one of the fixed
 * session ids the scripts hard-code. Necessary to be ours — never sufficient. Sibling
 * worktrees on the same machine run these exact scripts with these exact ids, so a match
 * alone identifies the SUITE, not the RUN.
 */
export const OUR_PROCESS_PATTERNS: readonly RegExp[] = [
	/dev3-guarded-send-/,
	/dev3-pane-input(-owner)?-e2e-/,
	/dev3-native-registry-e2e-/,
	/dev3-native-message-e2e-/,
	/dev3-multipane-e2e-/,
	/dev3-live-/,
	/[/\\]d3or-/,
	// Fixed task ids the scripts hard-code, plus the registry/multipane session names.
	/dev3-task-00000000-0000-4000-8000-/,
	/dev3-task-eeeeeeee-1111-2222-3333-444444444444/,
	/dev3-task-11111111-2222-3333-4444-555555555555/,
	/session-host\s+owner-routing-/,
	/session-host\s+(alpha|bravo|mpe2e)\b/,
	// A native host of any kind. Weakest signal, and deliberately included: in CI nothing
	// else can produce one.
	/dev3-terminal-host/,
];

/**
 * WHY ATTRIBUTION IS BY OUR OWN FOOTPRINT, NOT BY HOW dev3-ish A COMMAND LOOKS.
 *
 * This gate went red once on a clean tree and the cause was neither a leak nor tmux: a
 * SIBLING WORKTREE was running the same e2e scripts at the same time, so its processes
 * carried the same hard-coded session ids and appeared "new" against our baseline. A
 * developer machine also runs a dozen real native hosts, and one that starts mid-run is
 * new by construction.
 *
 * So a survivor is only OURS when its argv names something only this run can have touched:
 * our repo root, or a temp root that appeared during this run. Everything else that looks
 * like the suite is UNATTRIBUTABLE — a leak in CI, where a single checkout and no running
 * app make ambiguity impossible, and merely reported on a developer machine, where calling
 * it a leak would cry wolf. The guard genuinely has different truth conditions in the two
 * environments, and pretending otherwise in either direction is the bug.
 */
export interface RunFootprint {
	/** Absolute path of the checkout this run belongs to — the one thing only we can have. */
	readonly repoRoot: string;
}

export function ownsProcess(command: string, footprint: RunFootprint): boolean {
	return command.includes(footprint.repoRoot);
}

/** Temp-dir prefixes the scripts create; a survivor means a script is not self-cleaning. */
export const OUR_TEMP_PREFIXES: readonly string[] = [
	"dev3-guarded-send-",
	"dev3-pane-input-e2e-",
	"dev3-pane-input-owner-e2e-",
	"dev3-native-registry-e2e-",
	"dev3-native-message-e2e-",
	"dev3-multipane-e2e-",
	"d3or-",
];

export interface ProcessEntry {
	readonly pid: number;
	readonly command: string;
}

export interface E2eResult {
	readonly name: string;
	readonly tier: E2eTier;
	readonly ms: number;
	/** The script itself exited 0 and was not killed. */
	readonly ok: boolean;
	/** Survivors carrying an e2e-only marker — a leak anywhere. */
	readonly orphans: readonly string[];
	/** Native hosts with no e2e marker — a leak in CI, merely reported on a dev machine. */
	readonly ambiguous: readonly string[];
	readonly tempLeaks: readonly string[];
}

export function selectScripts(tier: E2eTier | "all"): readonly E2eScript[] {
	return tier === "all" ? TERMINAL_E2E_SCRIPTS : TERMINAL_E2E_SCRIPTS.filter((script) => script.tier === tier);
}

/** `ps -o pid=,command=` output → entries. Lines it cannot parse are dropped, not guessed. */
export function parseProcessTable(psOutput: string): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const line of psOutput.split("\n")) {
		const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
		if (match) entries.push({ pid: Number(match[1]), command: match[2] });
	}
	return entries;
}

/** Looks like this suite. Necessary, not sufficient — see {@link RunFootprint}. */
export function looksLikeSuite(command: string): boolean {
	return OUR_PROCESS_PATTERNS.some((pattern) => pattern.test(command));
}

/** Ours beyond doubt: it looks like the suite AND names this run's own footprint. */
export function isOurProcess(command: string, footprint: RunFootprint): boolean {
	return looksLikeSuite(command) && ownsProcess(command, footprint);
}

/** Looks like the suite but could belong to a sibling worktree or the running app. */
export function isAmbiguousProcess(command: string, footprint: RunFootprint): boolean {
	return looksLikeSuite(command) && !ownsProcess(command, footprint);
}

export function isOurTempEntry(name: string): boolean {
	return OUR_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Live processes keyed `pid\tcommand`, so a recycled pid running something of ours still
 * reads as new rather than being mistaken for the baseline entry.
 */
export function processKeys(
	entries: readonly ProcessEntry[],
	selfPid: number,
	match: (command: string) => boolean,
): Set<string> {
	const keys = new Set<string>();
	for (const entry of entries) {
		if (entry.pid === selfPid) continue;
		if (match(entry.command)) keys.add(`${entry.pid}\t${entry.command}`);
	}
	return keys;
}

/** Everything present now that was not present at baseline. */
export function survivors(baseline: ReadonlySet<string>, now: ReadonlySet<string>): string[] {
	return [...now].filter((entry) => !baseline.has(entry));
}

/**
 * A temp root carries no repo path, so it can never be attributed to one run among several
 * on a shared machine — it is judged exactly like an unattributable process.
 */
export function verdictOf(result: E2eResult, inCi: boolean): "FAILED" | "ORPHANED" | "LEAKED" | "passed" {
	if (!result.ok) return "FAILED";
	if (result.orphans.length > 0) return "ORPHANED";
	if (inCi && result.ambiguous.length > 0) return "ORPHANED";
	if (inCi && result.tempLeaks.length > 0) return "LEAKED";
	return "passed";
}

export function isClean(result: E2eResult, inCi: boolean): boolean {
	return verdictOf(result, inCi) === "passed";
}

/** Whether a survivor should stop the run: attributable always, unattributable only in CI. */
export function shouldStop(result: E2eResult, inCi: boolean): boolean {
	if (result.orphans.length > 0) return true;
	return inCi && (result.ambiguous.length > 0 || result.tempLeaks.length > 0);
}

/** Anything worth writing down, whether or not it failed the run. */
export function hasSurvivors(result: E2eResult): boolean {
	return result.orphans.length + result.ambiguous.length + result.tempLeaks.length > 0;
}

/**
 * The only thing standing between an ambiguous survivor and a silent pass on a developer
 * machine. Pinned by a test for exactly that reason — a warning nobody reads is a pass,
 * and an untested string is decoration.
 */
export const AMBIGUOUS_LOCAL_WARNING =
	"UNATTRIBUTABLE SURVIVOR — looks like this suite but names neither our repo root nor a temp root from this run, so it may belong to a sibling worktree or your own dev3 app. Reported and NOT failed. In CI it would fail:";

/** Everything a future reader needs to diagnose a survivor without having been at the keyboard. */
export function renderEvidence(results: readonly E2eResult[], inCi: boolean): string {
	const lines: string[] = [];
	for (const result of results) {
		const verdict = verdictOf(result, inCi);
		if (verdict === "passed" && !hasSurvivors(result)) continue;
		lines.push(`## test:${result.name} — ${verdict} (${(result.ms / 1000).toFixed(1)} s, CI=${inCi})`);
		for (const orphan of result.orphans) lines.push(`orphan (attributable): ${orphan.replace("\t", " ")}`);
		for (const host of result.ambiguous) lines.push(`orphan (unattributable): ${host.replace("\t", " ")}`);
		for (const leak of result.tempLeaks) lines.push(`leftover temp dir: ${leak}`);
		lines.push("");
	}
	return lines.join("\n");
}

/** The honest runtime readout: per script, plus a total nobody has to add up. */
export function renderRuntimeTable(results: readonly E2eResult[], inCi: boolean): string {
	const totalMs = results.reduce((sum, result) => sum + result.ms, 0);
	const failed = results.filter((result) => !isClean(result, inCi));
	const rows = results.map(
		(result) =>
			`| \`test:${result.name}\` | ${result.tier} | ${(result.ms / 1000).toFixed(1)} s | ${verdictOf(result, inCi)} |`,
	);
	return [
		"| script | tier | runtime | verdict |",
		"| --- | --- | --- | --- |",
		...rows,
		`| **total (${results.length} scripts)** | | **${(totalMs / 1000).toFixed(1)} s** | ${
			failed.length === 0 ? "all passed" : `${failed.length} failed`
		} |`,
	].join("\n");
}
