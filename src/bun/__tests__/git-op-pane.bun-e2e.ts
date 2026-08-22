#!/usr/bin/env bun
/**
 * The git-operation panes, EXECUTED, against throwaway repositories (Seq 1547).
 *
 * These scripts push, rebase and squash-merge — they rewrite history and touch a
 * remote — so "the pane opened" is not evidence about them. What is proved here
 * is that the git operation COMPLETED and that dev3 read the right verdict back:
 *
 *   push     the remote ref actually moved, and the verdict file reads "0"
 *   rebase   the branch is linear on top of the base, verdict "0"
 *   conflict git's own CONFLICT message reaches the pane, verdict NON-zero, and
 *            the script terminates rather than hanging on its own keypress prompt
 *   merge    a squash commit lands with a subject carrying a double quote — the
 *            case `-m '<title>'` mangles under PowerShell 5.1 argument quoting
 *
 * WHY IT MUST RUN ON WINDOWS: the whole defect class here is invisible from
 * macOS. Two examples this file exists to catch, both of which look like success
 * from a POSIX run:
 *   - the verdict file's ENCODING. PowerShell 5.1's `>` is `Out-File`, which
 *     writes UTF-16LE with a byte-order mark. Measured on windows-latest: Bun's
 *     text decoder copes with that, so the decoded read still says "0" — which is
 *     exactly why the bytes are asserted too. dev3 must not depend on an
 *     undocumented decoder behaviour to learn whether a push succeeded.
 *   - a `$LASTEXITCODE` left over from a previous command reports a push that
 *     never launched as successful.
 * The POSIX legs are the control that none of this changed macOS/Linux.
 *
 * Run: bun run test:git-op-pane   (all three platforms)
 */

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../spawn";
import {
	buildGitOpScript,
	mergeGitOpSpec,
	pushGitOpSpec,
	rebaseGitOpSpec,
	writeMergeCommitMessage,
} from "../git-op-script";
import { generatedScriptLaunch, generatedScriptName, writeLaunchScript } from "../rpc-handlers/shared-pure";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}) in ${cwd}: ${err}`);
	return out.trim();
}

/**
 * Run one generated pane script exactly the way a pane does: written through
 * `writeLaunchScript` (so a Windows `.ps1` gets its byte-order mark) and launched
 * through `generatedScriptLaunch` (so the executable and argv are the app's, not
 * this test's idea of them).
 *
 * stdin is closed. That is not a convenience — the failure path ends in "press
 * any key", and a script that blocks there forever would hang the pane after a
 * conflict just as surely as it hangs this run.
 */
async function runPaneScript(
	name: string,
	cwd: string,
	scriptDir: string,
	body: string,
): Promise<{ code: number; output: string }> {
	const scriptPath = join(scriptDir, generatedScriptName(name)).replaceAll("\\", "/");
	await writeLaunchScript(scriptPath, body);
	const launch = generatedScriptLaunch(scriptPath);
	const proc = spawn([launch.executable, ...launch.argv], {
		cwd,
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

/** The verdict as `monitorGitPane` reads it — same call, same trim. */
async function readVerdict(exitFilePath: string): Promise<string> {
	return (await Bun.file(exitFilePath).text()).trim();
}

/**
 * The verdict file's BYTES, not its decoded text.
 *
 * The decoded read above passes even when the file is UTF-16LE with a byte-order
 * mark, because Bun's text decoder copes with it. That makes the decoded check
 * blind to the encoding — a mutation restoring PowerShell's `>` redirection slips
 * straight through it. What dev3 actually depends on is that the file is plain
 * ASCII digits, so that is what gets asserted; the hexdump is printed on failure
 * because "which encoding did it write" is the whole question.
 */
async function checkVerdictBytes(exitFilePath: string): Promise<void> {
	const bytes = new Uint8Array(await Bun.file(exitFilePath).arrayBuffer());
	const printable = [...bytes].every((byte) => (byte >= 0x30 && byte <= 0x39) || byte === 0x0a || byte === 0x0d);
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
	check(printable, `the verdict file is plain ASCII digits, no byte-order mark, no UTF-16 padding (bytes: ${hex})`);
}

async function seedRepo(root: string): Promise<{ origin: string; work: string; scripts: string }> {
	const origin = join(root, "origin.git").replaceAll("\\", "/");
	const seed = join(root, "seed").replaceAll("\\", "/");
	const work = join(root, "work").replaceAll("\\", "/");
	const scripts = join(root, "scripts").replaceAll("\\", "/");
	mkdirSync(scripts, { recursive: true });

	await git(root, "init", "--bare", "--initial-branch=main", origin);
	await git(root, "clone", origin, seed);
	await git(seed, "config", "user.email", "e2e@dev3.test");
	await git(seed, "config", "user.name", "dev3 e2e");
	await Bun.write(join(seed, "base.txt"), "one\n");
	await git(seed, "add", "-A");
	await git(seed, "commit", "-m", "base");
	await git(seed, "push", "origin", "main");

	await git(root, "clone", origin, work);
	await git(work, "config", "user.email", "e2e@dev3.test");
	await git(work, "config", "user.name", "dev3 e2e");
	return { origin, work, scripts };
}

async function testPush(root: string): Promise<void> {
	console.log("\npush — the remote ref moves and the verdict is readable");
	const { origin, work, scripts } = await seedRepo(join(root, "push"));
	await git(work, "checkout", "-b", "feature");
	await Bun.write(join(work, "pushed.txt"), "hello\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "pushed commit");
	const localHead = await git(work, "rev-parse", "HEAD");

	const exitFilePath = join(scripts, "push.exit").replaceAll("\\", "/");
	const { code, output } = await runPaneScript(
		"git-push",
		work,
		scripts,
		buildGitOpScript(pushGitOpSpec({ exitFilePath })),
	);

	check(code === 0, `the script exits 0 (got ${code})`);
	check(await readVerdict(exitFilePath) === "0", "the verdict file reads exactly \"0\"");
	await checkVerdictBytes(exitFilePath);
	const remoteHead = await git(origin, "rev-parse", "refs/heads/feature");
	check(remoteHead === localHead, "origin/feature now points at the local commit — the push really happened");
	check(output.includes("Push complete"), "the pane shows the success line");
}

/**
 * The rebase-then-push case, end to end against real git.
 *
 * Three things get proven here that no unit test can: that a PLAIN push is really
 * refused after a rebase (the failure users hit), that the leased force push
 * really lands, and that the lease really REFUSES when origin moved after the sha
 * was read. The third is the whole reason for the explicit `<branch>:<sha>` form —
 * a mutation back to a bare `--force-with-lease` would still pass the first two.
 */
async function testForcePushWithLease(root: string): Promise<void> {
	console.log("\nforce push — a rebase diverges the branch and the lease decides");
	const base = join(root, "force");
	const { origin, work, scripts } = await seedRepo(base);
	await git(work, "checkout", "-b", "feature");
	await Bun.write(join(work, "mine.txt"), "mine\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "my commit");
	await git(work, "push", "origin", "HEAD");

	// A base that moved plus a rebase is exactly how the branch diverges in dev3.
	const other = join(base, "other").replaceAll("\\", "/");
	await git(base, "clone", origin, other);
	await git(other, "config", "user.email", "e2e@dev3.test");
	await git(other, "config", "user.name", "dev3 e2e");
	await Bun.write(join(other, "upstream.txt"), "upstream\n");
	await git(other, "add", "-A");
	await git(other, "commit", "-m", "upstream commit");
	await git(other, "push", "origin", "main");
	await git(work, "fetch", "origin", "main");
	await git(work, "rebase", "origin/main");

	// 1. The plain push must fail — otherwise the whole escalation is unnecessary.
	const plainExit = join(scripts, "plain.exit").replaceAll("\\", "/");
	const plain = await runPaneScript("git-push", work, scripts, buildGitOpScript(pushGitOpSpec({ exitFilePath: plainExit })));
	check(plain.code !== 0, `a plain push after the rebase is refused (got ${plain.code})`);
	check(plain.output.includes("non-fast-forward") || plain.output.includes("rejected"), "git's own non-fast-forward message reached the pane");

	// 2. The lease, against the sha origin actually holds, must land.
	await git(work, "fetch", "origin", "feature");
	const expectSha = await git(work, "rev-parse", "origin/feature");
	const localHead = await git(work, "rev-parse", "HEAD");
	const leaseExit = join(scripts, "lease.exit").replaceAll("\\", "/");
	const leased = await runPaneScript(
		"git-push",
		work,
		scripts,
		buildGitOpScript(pushGitOpSpec({ exitFilePath: leaseExit, lease: { branch: "feature", expectSha } })),
	);
	check(leased.code === 0, `the leased force push exits 0 (got ${leased.code})`);
	check(await readVerdict(leaseExit) === "0", "the verdict file reads exactly \"0\"");
	await checkVerdictBytes(leaseExit);
	check(await git(origin, "rev-parse", "refs/heads/feature") === localHead, "origin/feature now points at the rebased commit");
	check(leased.output.includes("Force push complete"), "the pane says it was a force push");

	// 3. Someone else pushes, the lease is now stale, and it MUST refuse. This is
	//    the case a bare `--force-with-lease` against a stale tracking ref would
	//    silently overwrite.
	await git(other, "fetch", "origin", "feature");
	await git(other, "checkout", "-B", "feature", "origin/feature");
	await Bun.write(join(other, "theirs.txt"), "theirs\n");
	await git(other, "add", "-A");
	await git(other, "commit", "-m", "their commit");
	await git(other, "push", "origin", "feature");
	const theirHead = await git(origin, "rev-parse", "refs/heads/feature");

	await Bun.write(join(work, "mine2.txt"), "mine2\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "my second commit");
	const staleExit = join(scripts, "stale.exit").replaceAll("\\", "/");
	const stale = await runPaneScript(
		"git-push",
		work,
		scripts,
		// `expectSha` is deliberately the OLD value — dev3 read it before their push.
		buildGitOpScript(pushGitOpSpec({ exitFilePath: staleExit, lease: { branch: "feature", expectSha } })),
	);
	check(stale.code !== 0, `the stale lease is refused (got ${stale.code})`);
	check(await git(origin, "rev-parse", "refs/heads/feature") === theirHead, "their commit survived — the lease protected it");
	check(stale.output.includes("Force push failed"), "the pane names the failed operation");
	check(stale.output.includes("origin has moved"), "the pane explains why the lease refused");
}

async function testRebaseClean(root: string): Promise<void> {
	console.log("\nrebase — the branch lands on top of a base that moved");
	const { origin, work, scripts } = await seedRepo(join(root, "rebase"));
	const other = join(root, "rebase", "other").replaceAll("\\", "/");
	await git(join(root, "rebase"), "clone", origin, other);
	await git(other, "config", "user.email", "e2e@dev3.test");
	await git(other, "config", "user.name", "dev3 e2e");
	await Bun.write(join(other, "upstream.txt"), "upstream\n");
	await git(other, "add", "-A");
	await git(other, "commit", "-m", "upstream commit");
	await git(other, "push", "origin", "main");

	await git(work, "checkout", "-b", "feature");
	await Bun.write(join(work, "mine.txt"), "mine\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "my commit");

	const exitFilePath = join(scripts, "rebase.exit").replaceAll("\\", "/");
	const { code, output } = await runPaneScript(
		"git-rebase",
		work,
		scripts,
		buildGitOpScript(rebaseGitOpSpec({ exitFilePath, fetchBranch: "main", rebaseTarget: "origin/main" })),
	);

	check(code === 0, `the script exits 0 (got ${code})`);
	check(await readVerdict(exitFilePath) === "0", "the verdict file reads exactly \"0\"");
	await checkVerdictBytes(exitFilePath);
	const log = await git(work, "log", "--format=%s", "-3");
	check(
		log.split("\n").map((line) => line.trim()).slice(0, 3).join("|") === "my commit|upstream commit|base",
		`the rebase really replayed the commit onto the moved base (log: ${log.replaceAll("\n", " / ")})`,
	);
	check(output.includes("git rebase origin/main"), "the pane echoed the git command it ran");
}

async function testRebaseConflict(root: string): Promise<void> {
	console.log("\nrebase conflict — the real git message, a non-zero verdict, and no hang");
	const { origin, work, scripts } = await seedRepo(join(root, "conflict"));
	const other = join(root, "conflict", "other").replaceAll("\\", "/");
	await git(join(root, "conflict"), "clone", origin, other);
	await git(other, "config", "user.email", "e2e@dev3.test");
	await git(other, "config", "user.name", "dev3 e2e");
	await Bun.write(join(other, "base.txt"), "upstream side\n");
	await git(other, "add", "-A");
	await git(other, "commit", "-m", "upstream edit");
	await git(other, "push", "origin", "main");

	await git(work, "checkout", "-b", "feature");
	await Bun.write(join(work, "base.txt"), "my side\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "my edit");

	const exitFilePath = join(scripts, "conflict.exit").replaceAll("\\", "/");
	const started = Date.now();
	const { code, output } = await runPaneScript(
		"git-rebase",
		work,
		scripts,
		buildGitOpScript(rebaseGitOpSpec({ exitFilePath, fetchBranch: "main", rebaseTarget: "origin/main" })),
	);
	const elapsedMs = Date.now() - started;

	check(code !== 0, `the script exits non-zero (got ${code})`);
	const verdict = await readVerdict(exitFilePath);
	check(verdict !== "" && verdict !== "0", `the verdict file reads a real failure code (got "${verdict}")`);
	await checkVerdictBytes(exitFilePath);
	check(/CONFLICT|could not apply|Merge conflict/i.test(output), "git's own conflict message reached the pane");
	check(output.includes("Rebase failed"), "the pane says which operation failed");
	check(output.includes("git rebase --abort"), "the pane shows the way out");
	check(elapsedMs < 60_000, `the script terminated instead of blocking on its keypress prompt (${elapsedMs} ms)`);
	// The rebase is left mid-flight on purpose: that is the state the user is told
	// to resolve, and a script that silently aborted would be losing their work.
	const status = await git(work, "status", "--porcelain=v2", "--branch");
	check(!status.includes("fatal"), "the worktree is still a usable repository after the failure");
}

async function testMerge(root: string): Promise<void> {
	console.log("\nmerge — a squash commit whose subject survives both dialects");
	const { work, scripts } = await seedRepo(join(root, "merge"));
	await git(work, "checkout", "-b", "feature");
	await Bun.write(join(work, "feature.txt"), "feature\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "feature work");
	await git(work, "checkout", "main");

	// The exact shape `-m '<title>'` could not carry: a double quote, a single
	// quote and a `$`, all in one subject.
	const title = `Fix the "quoted" thing — it's $HOME, not %HOME%`;
	const messagePath = join(scripts, "merge-message.txt").replaceAll("\\", "/");
	await writeMergeCommitMessage(messagePath, title);
	const exitFilePath = join(scripts, "merge.exit").replaceAll("\\", "/");

	const { code, output } = await runPaneScript(
		"git-merge",
		work,
		scripts,
		buildGitOpScript(mergeGitOpSpec({
			exitFilePath,
			checkoutCommand: null,
			baseBranch: "main",
			branchForMerge: "feature",
			messagePath,
		})),
	);

	check(code === 0, `the script exits 0 (got ${code})`);
	check(await readVerdict(exitFilePath) === "0", "the verdict file reads exactly \"0\"");
	await checkVerdictBytes(exitFilePath);
	const subject = await git(work, "log", "-1", "--format=%s");
	check(subject === title, `the commit subject round-tripped byte for byte (got: ${subject})`);
	const files = await git(work, "show", "--name-only", "--format=", "HEAD");
	check(files.includes("feature.txt"), "the squashed content is in the commit");
	check(output.includes("Merge complete"), "the pane shows the success line");
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-git-op-pane-"));
	console.log(`git-operation pane scripts on ${process.platform} (${root})`);
	try {
		await testPush(root);
		await testForcePushWithLease(root);
		await testRebaseClean(root);
		await testRebaseConflict(root);
		await testMerge(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
