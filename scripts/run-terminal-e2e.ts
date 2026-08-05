#!/usr/bin/env bun
/**
 * Runs the live terminal/native end-to-end scripts as one CI gate (seq 1422).
 *
 * These scripts prove what no unit test can: guard grammar against a REAL tmux
 * server, recycled pane ids across a server restart, exactly-once delivery across
 * three OS processes, ownership-verified teardown. Until now they only ran when a
 * human remembered, so reviewers kept having to mark those claims unverified.
 *
 * On top of running them this wrapper enforces the two properties a human eye used
 * to supply: nothing of ours survives the run (no tmux server, no native host, no
 * shell) and nothing of ours is left in the temp dir. Both FAIL the run — they are
 * never merely logged. The verdict logic is `src/bun/terminal-e2e-guard.ts`, unit
 * tested so the gate cannot silently stop detecting.
 *
 * Usage:
 *   bun scripts/run-terminal-e2e.ts             # every script
 *   bun scripts/run-terminal-e2e.ts --set fast  # the per-PR subset, if one is ever needed
 *   bun scripts/run-terminal-e2e.ts --list      # names only
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AMBIGUOUS_LOCAL_WARNING,
	isAmbiguousProcess,
	isClean,
	isOurProcess,
	isOurTempEntry,
	parseProcessTable,
	processKeys,
	renderEvidence,
	renderRuntimeTable,
	selectScripts,
	shouldStop,
	survivors,
	type E2eResult,
	type E2eTier,
} from "../src/bun/terminal-e2e-guard";

/** One script may not outlive this; a hang must fail the job, not occupy the runner. */
const PER_SCRIPT_TIMEOUT_MS = 300_000;

/** A process mid-teardown is not a leak. A survivor must still be there on a second look. */
const SETTLE_MS = 2_000;

/** Where the evidence lands, so the next occurrence is diagnosable by whoever sees it. */
const EVIDENCE_DIR = "terminal-e2e-evidence";

const IN_CI = process.env.CI === "true" || process.env.CI === "1";

function processSnapshot(): ProcessEntry[] {
	const ps = spawnSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return parseProcessTable(ps.stdout ?? "");
}

type ProcessEntry = ReturnType<typeof parseProcessTable>[number];

/**
 * This run's identity. `repoRoot` is fixed; `tempRoots` grows as scripts create their
 * throwaways, which is what lets a stranded `cat` be attributed to us rather than to a
 * sibling worktree running the same script.
 */
const footprint = { repoRoot: fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "") };

function liveOurProcesses(entries = processSnapshot()): Set<string> {
	return processKeys(entries, process.pid, (command) => isOurProcess(command, footprint));
}

function liveAmbiguousProcesses(entries = processSnapshot()): Set<string> {
	return processKeys(entries, process.pid, (command) => isAmbiguousProcess(command, footprint));
}

const sleep = (ms: number): void => {
	// Deliberately blocking: this runner is strictly sequential and a real pause between
	// the two looks is the whole point of the settle check.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function liveOurTempEntries(): Set<string> {
	try {
		return new Set(readdirSync(tmpdir()).filter(isOurTempEntry));
	} catch {
		return new Set();
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const setArg = args.find((arg) => arg.startsWith("--set="))?.slice("--set=".length) ?? args[args.indexOf("--set") + 1];
	const tier: E2eTier | "all" = setArg === "fast" || setArg === "full" ? setArg : "all";
	const selected = selectScripts(tier);

	if (args.includes("--list")) {
		for (const script of selected) console.log(`test:${script.name}  [${script.tier}]  ${script.proves}`);
		return;
	}

	// Anything matching before we start belongs to the developer's own dev3, not to us.
	const baselineSnapshot = processSnapshot();
	const baselineProcesses = liveOurProcesses(baselineSnapshot);
	const baselineAmbiguous = liveAmbiguousProcesses(baselineSnapshot);
	const baselineTemp = liveOurTempEntries();
	console.log(`Repo root:  ${footprint.repoRoot}`);
	console.log(`Baseline:   ${baselineProcesses.size} ours, ${baselineAmbiguous.size} unattributable, CI=${IN_CI}`);

	const results: E2eResult[] = [];
	for (const script of selected) {
		console.log(`\n${"=".repeat(70)}\n▶ test:${script.name} — ${script.proves}\n${"=".repeat(70)}`);
		const startedAt = Date.now();
		const run = spawnSync("bun", ["run", `test:${script.name}`], {
			stdio: "inherit",
			timeout: PER_SCRIPT_TIMEOUT_MS,
			encoding: "utf8",
		});
		const ms = Date.now() - startedAt;

		if (run.error) console.error(`  runner error: ${run.error.message}`);
		if (run.signal) console.error(`  killed by ${run.signal} (per-script timeout is ${PER_SCRIPT_TIMEOUT_MS} ms)`);

		// First look, then a second one after a pause: only a survivor present in BOTH counts,
		// so a process still tearing down is never reported as a leak.
		let orphans = survivors(baselineProcesses, liveOurProcesses());
		let ambiguous = survivors(baselineAmbiguous, liveAmbiguousProcesses());
		let tempLeaks = survivors(baselineTemp, liveOurTempEntries());
		if (orphans.length > 0 || ambiguous.length > 0 || tempLeaks.length > 0) {
			console.log(`  settling ${SETTLE_MS} ms before judging survivors…`);
			sleep(SETTLE_MS);
			const stillOurs = liveOurProcesses();
			const stillAmbiguous = liveAmbiguousProcesses();
			const stillTemp = liveOurTempEntries();
			orphans = orphans.filter((entry) => stillOurs.has(entry));
			ambiguous = ambiguous.filter((entry) => stillAmbiguous.has(entry));
			tempLeaks = tempLeaks.filter((entry) => stillTemp.has(entry));
		}

		for (const orphan of orphans) console.error(`  ORPHAN PROCESS: ${orphan.replace("\t", " ")}`);
		for (const host of ambiguous) {
			console.error(`  ${IN_CI ? "ORPHAN PROCESS:" : AMBIGUOUS_LOCAL_WARNING} ${host.replace("\t", " ")}`);
		}
		for (const leak of tempLeaks) {
			console.error(`  ${IN_CI ? "LEFTOVER TEMP DIR:" : AMBIGUOUS_LOCAL_WARNING} temp dir ${leak}`);
		}

		const result: E2eResult = {
			name: script.name,
			tier: script.tier,
			ms,
			ok: run.status === 0 && !run.signal,
			orphans,
			ambiguous,
			tempLeaks,
		};
		results.push(result);

		// A leak would be inherited by the next script's check and blamed on it, so stop
		// attributing once one is found.
		if (shouldStop(result, IN_CI)) break;
	}

	const failed = results.filter((result) => !isClean(result, IN_CI));
	const table = renderRuntimeTable(results, IN_CI);
	console.log(`\n${table}\n`);
	if (results.length < selected.length) {
		console.log(`Stopped early: ${selected.length - results.length} script(s) never ran.`);
	}

	// Written before the exit, always: a gate that catches the rarest failure and then
	// discards the evidence is a rumour, not a gate.
	const evidence = renderEvidence(results, IN_CI);
	if (evidence) {
		mkdirSync(EVIDENCE_DIR, { recursive: true });
		const file = join(EVIDENCE_DIR, `survivors-${process.platform}.txt`);
		writeFileSync(file, `${evidence}\n${table}\n`);
		console.log(`Evidence written to ${file}`);
	}

	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) {
		const heading = `### Live terminal e2e — ${process.platform} (${failed.length === 0 ? "green" : "red"})`;
		const detail = evidence ? `\n\`\`\`\n${evidence}\`\`\`\n` : "";
		appendFileSync(summaryPath, `${heading}\n\n${table}\n${detail}\n`);
	}

	if (failed.length > 0) {
		console.error(`\n${failed.length} script(s) did not pass cleanly: ${failed.map((result) => result.name).join(", ")}`);
		process.exit(1);
	}
	console.log("Every script passed, no orphan process survived, no temp dir was left behind.");
}

main();
