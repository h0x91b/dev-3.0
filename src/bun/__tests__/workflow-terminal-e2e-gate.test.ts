import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const build = readFileSync(resolve(repoRoot, ".github/workflows/build.yml"), "utf-8");

/**
 * One job's YAML, ending at the next top-level job key. Bounded that way on purpose: a
 * sibling task is adding jobs to this file, and slicing "up to `test:`" would silently
 * swallow whatever lands in between and judge its keys as ours.
 */
function jobBlock(name: string): string {
	const start = build.indexOf(`\n  ${name}:`);
	expect(start, `job "${name}" is missing from build.yml`).toBeGreaterThanOrEqual(0);
	const rest = build.slice(start + 1);
	const end = rest.search(/\n {2}[A-Za-z_][A-Za-z0-9_-]*:/);
	return end === -1 ? rest : rest.slice(0, end);
}

/** The `run:` body of one named step, comments stripped the same way the sibling workflow tests do. */
function stepBlock(workflow: string, name: string): string {
	const lines = workflow.split("\n");
	const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s+name:\\s*${name}\\s*$`).test(line));
	expect(start, `step "${name}" is missing from build.yml`).toBeGreaterThanOrEqual(0);
	const block: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*-\s+(name|uses):/.test(line)) break;
		if (!line.trim().startsWith("#")) block.push(line);
	}
	return block.join("\n");
}

// The live terminal e2e job proves what only a real tmux server or a real native host can.
// It gates PRs through the already-required `test` context rather than through a
// branch-protection entry, so the wiring that makes it gate lives entirely in this file —
// and is therefore deletable by accident.
// See decisions/2026/08/06/live-terminal-e2e-gated-through-test-context.md — named by slug because
// bare numbers collided three times in one day and a neighbouring record read as permission.
describe("the live terminal e2e job is wired to gate PRs", () => {
	it("runs on both macOS and Ubuntu without fail-fast", () => {
		expect(build).toMatch(/terminal_e2e:/);
		const job = jobBlock("terminal_e2e");
		expect(job).toMatch(/os:\s*\[ubuntu-latest,\s*macos-latest\]/);
		expect(job).toMatch(/fail-fast:\s*false/);
		expect(job, "the gate must run the whole set, not a narrowed subset").toMatch(
			/bun scripts\/run-terminal-e2e\.ts\s*$/m,
		);
	});

	it("generates build files first, or two scripts die on a missing generated module", () => {
		const job = jobBlock("terminal_e2e");
		const generate = job.indexOf("generate-changelog.ts");
		const run = job.indexOf("run-terminal-e2e.ts");
		expect(generate).toBeGreaterThanOrEqual(0);
		expect(generate, "generate-changelog must run before the e2e scripts").toBeLessThan(run);
	});

	it("is a dependency of the required `test` context", () => {
		// Membership, scoped to the `test` job, not an exact list: that array changes as
		// sibling gates land on or leave the required context (the Windows packaging gate
		// did both — decisions/2026/08/06/windows-proof-post-merge-not-pull-request.md). Scoped, because
		// membership checked file-wide would still pass if terminal_e2e were moved into
		// some other job's needs while the required context stopped waiting for it.
		const job = jobBlock("test");
		expect(job).toMatch(/needs:\s*\[[^\]]*\bterminal_e2e\b[^\]]*\]/);
	});

	// The change's own worst moment: a survivor was detected, the detail went to stdout
	// only, and the evidence was lost to a `tail -3`. Never again by accident.
	it("uploads the survivor evidence when it fails", () => {
		const job = jobBlock("terminal_e2e");
		expect(job).toMatch(/name:\s*terminal-e2e-evidence-\$\{\{\s*matrix\.os\s*\}\}/);
		expect(job).toMatch(/path:\s*terminal-e2e-evidence\//);
		expect(job, "the evidence upload must survive a failing run").toMatch(/if:\s*failure\(\)/);
	});
});

// The highest-leverage lines in the change: `skipped` is treated as a PASS so one future
// path filter cannot red the required context on every PR, and the ONLY thing then standing
// between a gate that stopped running and a silent green is the annotation below. An
// untested string is decoration, which is the exact rot this whole change exists to stop.
describe("the terminal e2e gate step", () => {
	const gate = stepBlock(build, "Verify the live terminal e2e gate");

	it("reads the job result rather than assuming it ran", () => {
		expect(gate).toMatch(/TERMINAL_E2E_RESULT:\s*\$\{\{\s*needs\.terminal_e2e\.result\s*\}\}/);
	});

	it("announces a skipped gate loudly instead of passing it in silence", () => {
		const skipped = gate.slice(gate.indexOf("skipped)"), gate.indexOf("*)"));
		expect(skipped, "the skipped branch is missing").not.toBe("");
		expect(skipped, "a skipped gate must emit a ::warning annotation").toMatch(
			/::warning title=Live terminal e2e::.*\S/,
		);
		expect(skipped, "a skipped gate must say so on the run summary, where humans look").toMatch(
			/>>\s*"\$GITHUB_STEP_SUMMARY"/,
		);
		expect(skipped, "a skipped gate must NOT fail — that would block every merge in the repo").not.toMatch(/exit 1/);
	});

	it("fails on failure and on cancellation", () => {
		const fallthrough = gate.slice(gate.indexOf("*)"));
		expect(fallthrough).toMatch(/::error title=Live terminal e2e::/);
		expect(fallthrough).toMatch(/exit 1/);
	});

	it("does not swallow the shard report, and is not swallowed by it", () => {
		expect(gate).toMatch(/continue-on-error:\s*true/);
		expect(stepBlock(build, "Verify test shards")).toMatch(/continue-on-error:\s*true/);
		const final = stepBlock(build, "Fail if any gate is red");
		expect(final).toMatch(/steps\.terminal_gate\.outcome/);
		expect(final).toMatch(/steps\.shards\.outcome/);
	});
});

// Two tripwires guarding two DIFFERENT failures. Each is asserted at the level where its own
// failure lives, and nothing wider — a scan that reds a correct change is the worst kind of red.
//
// Silent green needs an asymmetry: this job absent while `test` still runs. Only a job-level
// `if:` produces it (result `skipped`, which this gate passes). A job-level `concurrency` cancel
// yields `cancelled`, which the gate already fails hard on, so it needs no tripwire. File-level
// mechanisms cannot produce the asymmetry at all: they take `test` down with the whole workflow.
describe("nothing can leave the terminal e2e job absent while `test` still reports", () => {
	it("puts no `if:` condition on the job itself", () => {
		// THE load-bearing assertion: this, and only this, is why three cases are enough
		// instead of the four-case "deliberately not dispatched" shape.
		const job = jobBlock("terminal_e2e");
		expect(
			/^\s{4}if:/m.test(job),
			"a job-level `if:` makes this gate skippable, and a skip passes — that needs a second, independently computed did-not-dispatch reason, cross-checked, before it is safe",
		).toBe(false);
	});
});

// A different failure, hence a different scan: not silent green, but a required context with no
// check run at all. Stays file-wide because that is the level the damage lives at.
describe("build.yml owns a required context, so it must trigger on every PR", () => {
	it("has no workflow-level path filter", () => {
		expect(
			/^\s*paths(-ignore)?:/m.test(build),
			"a paths filter here means out-of-scope PRs get no check run, so the required `test` context sits pending forever and nothing merges — scoping belongs in a callee's own gate, never in this file",
		).toBe(false);
	});
});
