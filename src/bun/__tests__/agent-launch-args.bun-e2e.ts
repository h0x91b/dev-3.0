#!/usr/bin/env bun
/**
 * The agent command line, EXECUTED on this runner's real platform (Seq 1737).
 *
 * Windows agent launch was dead for every Claude session: the command line was
 * POSIX-quoted (`'\''` for an apostrophe) and then handed to
 * `Invoke-Expression`, where `\` ends the string literal. The dev3 system prompt
 * says "the task's title", so every launch died with a PowerShell ParserError
 * before the agent binary was even looked up. The dialect record predicted this
 * ("complex quoting will need a separate normalisation pass").
 *
 * A pure test can pin the text, and it does — but the text is only half the
 * question. Two parsers stand between dev3 and the agent's `argv`: PowerShell
 * builds a raw command line, then the callee's C runtime splits it again. What is
 * proved here is the whole chain: every argument dev3 writes arrives at the
 * binary BYTE-IDENTICAL, over a battery of strings picked to break one parser or
 * the other.
 *
 * The first Windows run of this file also found the bug BEHIND the reported one:
 * a Windows command line stops at 32 767 characters and the dev3 protocol is
 * ~34 000, so `--append-system-prompt <body>` could never have been delivered
 * there at any quoting. The ceiling leg proves that from the OS, and proves the
 * file-shaped command line dev3 sends instead.
 *
 * The POSIX legs are the control that none of this changed macOS/Linux.
 *
 * The "agent binary" is this runner's own `bun`, with a probe script as its
 * first argument — a real executable with ordinary C-runtime argument parsing,
 * which a `.cmd` shim would not be (cmd.exe parses its own way and would prove
 * something else). One leg copies that binary into a directory with a space in
 * its name, which is the `C:\Users\John Smith\...` case.
 *
 * Run: bun run test:agent-launch-args-e2e   (all three platforms)
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../spawn";
import { CLAUDE_SKILL_BODY } from "../../shared/agent-skill-content";
import { commandToken, shellEscape } from "../../shared/agent-adapters/shell";
import { WINDOWS_COMMAND_LINE_LIMIT } from "../agent-system-prompt-file";
import { buildCmdScript, generatedScriptLaunch, generatedScriptName, writeLaunchScript } from "../rpc-handlers/shared-pure";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const windows = process.platform === "win32";

const root = mkdtempSync(join(tmpdir(), "dev3-agent-args-e2e-"));
const RECORD = join(root, "argv.json");

/** The "agent": records the arguments it was given and exits 0. */
const PROBE = join(root, "probe.mjs");
writeFileSync(
	PROBE,
	[
		"import { writeFileSync } from 'node:fs';",
		`writeFileSync(${JSON.stringify(RECORD)}, JSON.stringify(process.argv.slice(2)));`,
	].join("\n"),
	"utf8",
);

/**
 * Arguments that break exactly one parser each. Everything here is a value dev3
 * really can emit: the system prompt is quoted verbatim, task titles and prompts
 * are the user's own text, and `--settings` carries a Windows path.
 */
const CASES: Array<[name: string, value: string]> = [
	["an apostrophe (the reported break)", "the task's title"],
	["a POSIX escape sequence, literally", "before '\\'' after"],
	["double quotes", 'he said "no" and left'],
	["a quote with no whitespace around it", 'x"y'],
	["backslashes before a quote", 'path\\\\"quoted"'],
	["a trailing backslash", "ends with a backslash \\"],
	["a lone backslash, no whitespace", "no-space\\"],
	["a PowerShell variable and subexpression", "$env:PATH and $(Get-Date)"],
	["a PowerShell backtick escape", "a `n b"],
	["a cmd-style variable reference", "%PATH% and %%"],
	["shell operators", "a && b || c ; d | e > f"],
	["a Windows path", "C:\\Users\\user\\.dev3.0\\data\\settings.json"],
	["newlines and tabs", "first\nsecond\tthird"],
	["non-ASCII", "Так, на винде — «агент» 🙂"],
	// Long but legal: a real task description reaches this size, and it has to
	// survive on every platform. The ceiling itself is a leg of its own below.
	["a long argument well inside the ceiling", `x${"long task description. ".repeat(400)}y`],
];

/**
 * Values that Windows PowerShell 5.1 does NOT deliver, whatever dev3 writes.
 * Asserted as observed rather than hidden, because silence here would read as
 * "covered". POSIX delivers both without a quibble, so they are only expectations
 * on Windows.
 *
 * `an odd number of double quotes` — 5.1 appears to close its own wrapping quote
 * at the first point where quotes balance, so the argument splits in two. The
 * obvious idea — emit quotes in PAIRS (`""`, which the C runtime also reads as
 * one literal quote inside a quoted block) so the count is always even — was
 * measured on a Windows runner and is WORSE: it breaks four cases this encoding
 * delivers and does not fix this one. No encoding closes it; it needs dev3 to
 * build the raw command line itself instead of letting PowerShell build it.
 *
 * `an empty argument` — 5.1 drops it from the command line entirely. dev3 never
 * emits one today (a prompt is pushed only when non-empty, and every flag value
 * is a model, mode, id or path), so this is documentation, not an outage.
 */
const KNOWN_WINDOWS_LIMITS: Array<[name: string, value: string]> = [
	["an odd number of double quotes", 'a" b'],
	["an empty argument", ""],
];

/**
 * Run the command line exactly the way a task pane does: assembled the way an
 * adapter assembles it, wrapped by `buildCmdScript`, written through
 * `writeLaunchScript` (a Windows `.ps1` needs its byte-order mark) and launched
 * through `generatedScriptLaunch`.
 *
 * stdin is closed on purpose: the failure branch hands the view to an
 * interactive shell, and a wrapper that blocks there hangs the pane the same way
 * it would hang this run.
 */
async function runAgent(binary: string, values: string[]): Promise<{ code: number; output: string }> {
	rmSync(RECORD, { force: true });
	const command = [commandToken(binary), shellEscape(PROBE), ...values.map(shellEscape)].join(" ");
	const scriptPath = join(root, generatedScriptName("run"));
	await writeLaunchScript(scriptPath, buildCmdScript(command));
	const launch = generatedScriptLaunch(scriptPath);
	const proc = spawn([launch.executable, ...launch.argv], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, output: `${out}\n${err}` };
}

function received(): string[] | null {
	if (!existsSync(RECORD)) return null;
	try {
		return JSON.parse(readFileSync(RECORD, "utf8")) as string[];
	} catch {
		return null;
	}
}

/** A short, quotable rendering of a value that may be 30 KB of system prompt. */
function brief(value: string): string {
	const json = JSON.stringify(value);
	return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

console.log(`agent command line on ${process.platform} (${process.execPath})`);

try {
	console.log("\nper-argument — each value arrives at the binary byte-identical");
	for (const [name, value] of CASES) {
		const { code, output } = await runAgent(process.execPath, [value]);
		const args = received();
		if (args === null) {
			check(false, `${name}: the binary never ran (exit ${code}) — ${JSON.stringify(output.trim().slice(-400))}`);
			continue;
		}
		check(
			args.length === 1 && args[0] === value,
			`${name}: got ${args.length} arg(s), ${brief(args[0] ?? "")}`,
		);
	}

	console.log("\nall at once — argument boundaries survive a full command line");
	{
		const values = CASES.map(([, value]) => value);
		const { code, output } = await runAgent(process.execPath, values);
		const args = received();
		if (args === null) {
			check(false, `the binary never ran (exit ${code}) — ${JSON.stringify(output.trim().slice(-400))}`);
		} else {
			check(args.length === values.length, `argument count preserved (${args.length} of ${values.length})`);
			const firstDrift = values.findIndex((value, index) => args[index] !== value);
			check(
				firstDrift === -1,
				firstDrift === -1
					? "every argument matches"
					: `argument ${firstDrift} (${CASES[firstDrift]?.[0]}) drifted: ${brief(args[firstDrift] ?? "")}`,
			);
		}
	}

	console.log("\nknown PowerShell 5.1 limitations — asserted, not hidden");
	for (const [name, value] of KNOWN_WINDOWS_LIMITS) {
		await runAgent(process.execPath, [value]);
		const args = received();
		const delivered = args !== null && args.length === 1 && args[0] === value;
		if (windows) check(!delivered, `${name}: still undelivered on 5.1 (got ${JSON.stringify(args)})`);
		else check(delivered, `${name}: delivered (got ${JSON.stringify(args)})`);
	}

	console.log("\nthe command-line ceiling — why the protocol travels as a file on Windows");
	{
		// The protocol body alone is longer than a whole Windows command line, so
		// `--append-system-prompt <body>` cannot be delivered there at any quoting.
		check(
			CLAUDE_SKILL_BODY.length > WINDOWS_COMMAND_LINE_LIMIT,
			`the dev3 protocol is ${CLAUDE_SKILL_BODY.length} chars against a ${WINDOWS_COMMAND_LINE_LIMIT}-char ceiling`,
		);
		const { output } = await runAgent(process.execPath, [CLAUDE_SKILL_BODY]);
		const args = received();
		const inlineWorked = args !== null && args.length === 1 && args[0] === CLAUDE_SKILL_BODY;
		if (windows) {
			check(!inlineWorked, "inline delivery is refused by the OS, not by dev3");
			check(
				/too long|ApplicationFailed|NativeCommandFailed/i.test(output),
				`the refusal names the command line (${JSON.stringify(output.trim().slice(-200))})`,
			);
		} else {
			check(inlineWorked, "POSIX has no such ceiling, so inline delivery still works there");
		}

		// The shape dev3 actually launches on Windows: a path, not a body.
		const promptFile = join(root, "claude.md");
		writeFileSync(promptFile, CLAUDE_SKILL_BODY, "utf8");
		const { code } = await runAgent(process.execPath, ["--append-system-prompt-file", promptFile]);
		const viaFile = received();
		check(
			viaFile !== null && viaFile[1] === promptFile,
			viaFile === null
				? `the file-shaped command line never ran (exit ${code})`
				: `the file-shaped command line is delivered on every platform (${JSON.stringify(viaFile)})`,
		);
	}

	console.log("\nbinary path with a space — the C:\\Users\\John Smith case");
	{
		const dir = join(root, "Program Files", "coding agent");
		mkdirSync(dir, { recursive: true });
		const binary = join(dir, process.platform === "win32" ? "agent.exe" : "agent");
		copyFileSync(process.execPath, binary);
		const { code, output } = await runAgent(binary, ["the task's title"]);
		const args = received();
		check(
			args !== null && args.length === 1 && args[0] === "the task's title",
			args === null
				? `the binary never ran (exit ${code}) — ${JSON.stringify(output.trim().slice(-400))}`
				: `the spaced-path binary ran and its argument survived (${brief(args[0] ?? "")})`,
		);
	}

} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
