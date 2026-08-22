/**
 * The generated git-operation pane scripts, per dialect (Seq 1547).
 *
 * Two jobs, and they are opposites:
 *  - POSIX is pinned as literal text. macOS and Linux users must see byte-for-byte
 *    what the hand-written bash produced in behaviour; a diff here is a change to
 *    every rebase, push and merge pane in the field.
 *  - Windows is asserted by PROPERTY, because there is no previous text to match.
 *    The properties are the ones whose absence is silent: no POSIX shell path, no
 *    `>` redirection of the verdict file, and a cleared `$LASTEXITCODE`.
 *
 * The verdict file is checked hardest on purpose. `>` in Windows PowerShell 5.1
 * writes UTF-16LE with a BOM, so a redirected verdict reads back as mojibake and
 * `monitorGitPane` reports every operation as failed — a defect that a macOS run
 * cannot see and that looks exactly like "the pane opened fine".
 */
import { describe, it, expect, afterEach } from "vitest";
import {
	buildGitOpScript,
	mergeGitOpSpec,
	pushGitOpSpec,
	rebaseGitOpSpec,
} from "../git-op-script";
import { generatedScriptName } from "../rpc-handlers/shared-pure";

const realPlatform = process.platform;
const realSystemRoot = process.env.SystemRoot;

function asPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	// %SystemRoot% is where the PowerShell 5.1 path comes from; a real Windows
	// session always has it, a simulated one has to supply it.
	if (platform === "win32") process.env.SystemRoot ??= "C:\\Windows";
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
	if (realSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = realSystemRoot;
});

const EXIT = "/tmp/dev3-T-git-rebase.sh.exit";

const POSIX_PUSH = [
	"#!/bin/bash",
	"printf '\\033[2m$ %s\\033[0m\\n' 'git push -u origin HEAD'",
	"'git' 'push' '-u' 'origin' 'HEAD'",
	"__DEV3_EC0=$?",
	"if [ $__DEV3_EC0 -ne 0 ]; then",
	"  printf '%s' \"$__DEV3_EC0\" > '/tmp/dev3-T-git-rebase.sh.exit'",
	"  printf '\\n\\033[1;31m✗ Push failed (exit %s)\\033[0m\\n' \"$__DEV3_EC0\"",
	"  printf '%s\\n' 'If git refused this as non-fast-forward, the branch was rebased after being pushed.'",
	"  printf '%s\\n' 'Refresh the branch status and use Force push, which leases against origin.'",
	"  printf '\\nPress any key to close this pane.\\n'",
	"  if [ -n \"$ZSH_VERSION\" ]; then read -k 1 -s; else read -n 1 -s; fi",
	"  exit $__DEV3_EC0",
	"fi",
	"printf '%s' \"$__DEV3_EC0\" > '/tmp/dev3-T-git-rebase.sh.exit'",
	"printf '\\n\\033[1;32m✓ Push complete\\033[0m\\n'",
	"sleep 2",
].join("\n") + "\n";

describe("POSIX git-op scripts (pinned)", () => {
	it("renders the push script exactly", () => {
		asPlatform("darwin");
		expect(buildGitOpScript(pushGitOpSpec({ exitFilePath: EXIT }))).toBe(POSIX_PUSH);
	});

	/**
	 * The lease value must be an EXPLICIT sha. A bare `--force-with-lease` leases
	 * against the remote-tracking ref on disk: it errors out when the branch has no
	 * upstream, and silently overwrites an unfetched push when that ref is stale.
	 */
	it("spells the force-with-lease value out as <branch>:<sha>", () => {
		asPlatform("darwin");
		const script = buildGitOpScript(pushGitOpSpec({
			exitFilePath: EXIT,
			lease: { branch: "feat/x", expectSha: "0123456789abcdef" },
		}));
		expect(script).toContain("'--force-with-lease=feat/x:0123456789abcdef'");
		// The bare form must never appear — it is the failure this exists to prevent.
		expect(script).not.toMatch(/'--force-with-lease'/);
		expect(script).not.toContain("--force '");
		expect(script).not.toMatch(/'-f'/);
		expect(script).toContain("Force push failed");
		expect(script).toContain("✓ Force push complete");
	});

	it("pushes plainly, and never forces, when no lease is supplied", () => {
		asPlatform("darwin");
		const script = buildGitOpScript(pushGitOpSpec({ exitFilePath: EXIT }));
		expect(script).not.toContain("force");
		expect(script).toContain("'git' 'push' '-u' 'origin' 'HEAD'");
	});

	it("keeps the rebase's fetch non-fatal and its conflict guidance intact", () => {
		asPlatform("darwin");
		const script = buildGitOpScript(rebaseGitOpSpec({
			exitFilePath: EXIT,
			fetchBranch: "main",
			rebaseTarget: "origin/main",
		}));
		// A failed fetch must not write a verdict or leave the script: the bash
		// original rebased onto the refs already on disk, and that is deliberate.
		expect(script).toContain("'git' 'fetch' 'origin' 'main' '--quiet'");
		expect(script).toMatch(/__DEV3_EC0 -ne 0[\s\S]*?continuing[\s\S]*?\nfi\n/);
		expect(script.match(/exit \$__DEV3_EC0/)).toBeNull();
		expect(script).toContain("'git' 'rebase' 'origin/main'");
		expect(script).toContain("git rebase --continue");
		expect(script).toContain("git rebase --abort");
	});

	it("passes the merge subject as a file, never as an argument", () => {
		asPlatform("darwin");
		const script = buildGitOpScript(mergeGitOpSpec({
			exitFilePath: EXIT,
			checkoutCommand: ["git", "checkout", "--track", "-b", "main", "origin/main"],
			baseBranch: "main",
			branchForMerge: "feat/x",
			messagePath: "/tmp/dev3-T-git-merge-message.txt",
		}));
		expect(script).toContain("'git' 'checkout' '--track' '-b' 'main' 'origin/main'");
		expect(script).toContain("'git' 'merge' '--squash' 'feat/x'");
		expect(script).toContain("'git' 'commit' '-F' '/tmp/dev3-T-git-merge-message.txt'");
		expect(script).not.toContain("commit' '-m");
	});

	it("omits the checkout step when the project is already on the base branch", () => {
		asPlatform("darwin");
		const script = buildGitOpScript(mergeGitOpSpec({
			exitFilePath: EXIT,
			checkoutCommand: null,
			baseBranch: "main",
			branchForMerge: "feat/x",
			messagePath: "/tmp/m.txt",
		}));
		// The COMMAND, not the word: guidance text may legitimately mention it.
		expect(script).not.toContain("'checkout'");
	});

	/**
	 * A merge that stops at the local base branch is a half-landing: with a remote,
	 * `origin/<base>` never hears about the squash and nothing says the local base
	 * is ahead. `pushBase` is the second half, and it must be the LAST (gating)
	 * step so its exit code is the operation's verdict.
	 */
	it("pushes the base branch last when pushBase is set", () => {
		asPlatform("darwin");
		const script = buildGitOpScript(mergeGitOpSpec({
			exitFilePath: EXIT,
			checkoutCommand: null,
			baseBranch: "main",
			branchForMerge: "feat/x",
			messagePath: "/tmp/m.txt",
			pushBase: true,
		}));
		expect(script).toContain("'git' 'push' 'origin' 'main'");
		expect(script).toContain("Merged and pushed to origin/main");
		expect(script.indexOf("'git' 'commit'")).toBeLessThan(script.indexOf("'git' 'push'"));
		// The push is the verdict step, so its failure must exit rather than warn.
		expect(script).toMatch(/Push failed[\s\S]*?exit \$__DEV3_EC/);
	});

	it("stays local when pushBase is absent", () => {
		asPlatform("darwin");
		const script = buildGitOpScript(mergeGitOpSpec({
			exitFilePath: EXIT,
			checkoutCommand: null,
			baseBranch: "main",
			branchForMerge: "feat/x",
			messagePath: "/tmp/m.txt",
		}));
		expect(script).not.toContain("'push'");
		expect(script).toContain("✓ Merge complete");
	});
});

describe("Windows git-op scripts", () => {
	const scripts = () => {
		asPlatform("win32");
		const exitFile = "C:/Temp/dev3-T-git-push.ps1.exit";
		return {
			push: buildGitOpScript(pushGitOpSpec({ exitFilePath: exitFile })),
			rebase: buildGitOpScript(rebaseGitOpSpec({ exitFilePath: exitFile, fetchBranch: "main", rebaseTarget: "origin/main" })),
			merge: buildGitOpScript(mergeGitOpSpec({
				exitFilePath: exitFile,
				checkoutCommand: ["git", "checkout", "main"],
				baseBranch: "main",
				branchForMerge: "feat/x",
				messagePath: "C:/Temp/dev3-T-git-merge-message.txt",
			})),
			exitFile,
		};
	};

	it("contains no bash whatsoever", () => {
		const { push, rebase, merge } = scripts();
		for (const script of [push, rebase, merge]) {
			expect(script).not.toContain("#!/bin/bash");
			expect(script).not.toContain("read -n 1 -s");
			expect(script).not.toMatch(/\bprintf '/);
			expect(script).not.toMatch(/=\$\?/);
		}
	});

	it("writes the verdict with an explicit ASCII write, never a redirection", () => {
		const { push, exitFile } = scripts();
		expect(push).toContain(`[System.IO.File]::WriteAllText('${exitFile}', [string]$__DEV3_EC0)`);
		// `>` here is UTF-16LE with a BOM in PowerShell 5.1: monitorGitPane would
		// read mojibake and call every operation a failure.
		expect(push).not.toContain(`> '${exitFile}'`);
		expect(push).not.toMatch(/>\s*["']?C:/);
	});

	it("clears $LASTEXITCODE before every command it judges", () => {
		const { push, rebase, merge } = scripts();
		for (const script of [push, rebase, merge]) {
			const runs = script.match(/^\$global:LASTEXITCODE = \$null; & /gm) ?? [];
			const captures = script.match(/^\$__DEV3_EC\d+ = /gm) ?? [];
			// A stale exit code from the PREVIOUS command is what turns "git could
			// not even launch" into a reported success.
			expect(runs.length).toBe(captures.length);
			expect(runs.length).toBeGreaterThan(0);
		}
	});

	it("never blocks on a keypress when console input is redirected", () => {
		const { push } = scripts();
		expect(push).toContain("[Console]::IsInputRedirected");
	});

	it("names the wrapper .ps1 so the launch and the file agree", () => {
		asPlatform("win32");
		expect(generatedScriptName("git-rebase")).toBe("git-rebase.ps1");
		asPlatform("darwin");
		expect(generatedScriptName("git-rebase")).toBe("git-rebase.sh");
	});
});

describe("buildGitOpScript", () => {
	it("refuses a script whose last step cannot produce a verdict", () => {
		asPlatform("darwin");
		expect(() => buildGitOpScript({
			exitFilePath: EXIT,
			successMessage: "Done",
			successHoldSeconds: 1,
			steps: [{ command: ["git", "fetch"], optional: true }],
		})).toThrow(/gating step/);
	});
});
