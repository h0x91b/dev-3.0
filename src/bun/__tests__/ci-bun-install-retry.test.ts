import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const script = resolve(repoRoot, ".github/actions/bun-install/install-with-retry.sh");
const buildYml = resolve(repoRoot, ".github/workflows/build.yml");

/**
 * Runs the real retry script against a FAKE `bun` on PATH, so the retry path is
 * exercised for real without depending on a registry that only fails sometimes.
 * The shim fails the first `failFirst` installs and succeeds after.
 */
function runScript(failFirst: number, args: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "bun-install-retry-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const counter = join(dir, "attempts");
	const stale = join(dir, "stale");
	writeFileSync(counter, "");
	writeFileSync(stale, "");
	const shim = join(bin, "bun");
	writeFileSync(
		shim,
		[
			"#!/usr/bin/env bash",
			'if [ "$1" = "install" ]; then',
			`  echo "$*" >> "${counter}"`,
			// Records whether this attempt inherited the previous attempt's tree.
			`  n=$(( $(wc -l < "${counter}") ))`,  // wc pads with spaces; arithmetic strips them
			`  if [ "$n" -gt 1 ] && [ -e "${dir}/node_modules/.from-attempt-1" ]; then echo stale >> "${stale}"; fi`,
			`  mkdir -p "${dir}/node_modules" && touch "${dir}/node_modules/.from-attempt-$n"`,
			`  if [ "$n" -le ${failFirst} ]; then`,
			'    echo \'error: Fail extracting tarball for "mermaid"\' >&2',
			"    exit 1",
			"  fi",
			"  exit 0",
			"fi",
			"exit 0", // `bun pm cache rm`
		].join("\n"),
	);
	chmodSync(shim, 0o755);

	const summary = join(dir, "summary.md");
	const result = spawnSync("bash", [script, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			GITHUB_STEP_SUMMARY: summary,
			BUN_INSTALL_RETRY_DELAYS: "0 0",
		},
	});

	return {
		status: result.status,
		output: `${result.stdout}${result.stderr}`,
		installs: readFileSync(counter, "utf8").trim().split("\n").filter(Boolean),
		summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
		staleTree: readFileSync(stale, "utf8").trim(),
	};
}

describe("CI bun install retry", () => {
	it("passes flags through and stays silent when the first attempt works", () => {
		const run = runScript(0, ["--frozen-lockfile"]);

		expect(run.status).toBe(0);
		expect(run.installs).toEqual(["install --frozen-lockfile"]);
		expect(run.output).not.toContain("::warning");
		expect(run.summary).toBe("");
	});

	it("retries a transient tarball failure and says so loudly", () => {
		const run = runScript(1);

		expect(run.status).toBe(0);
		expect(run.installs).toHaveLength(2);
		expect(run.output).toContain("::warning title=bun install failed::attempt 1/3 failed");
		expect(run.output).toContain("::warning title=bun install retried::bun install succeeded only on attempt 2");
		// A silent retry would hide how often the registry is failing, so the retry
		// must also reach the run summary a human actually reads.
		expect(run.summary).toContain("needed 2 attempts");
	});

	it("wipes the half-written tree before retrying", () => {
		const run = runScript(1);

		// A failed extraction can leave a partial node_modules; a retry on top of it
		// would install into a poisoned tree. The shim reports what it inherited.
		expect(run.output).toContain("attempt 2/3");
		expect(
			run.staleTree,
			"the retry inherited the failed attempt's node_modules instead of starting clean",
		).toBe("");
	});

	it("still fails the job when every attempt fails, after a bounded number of tries", () => {
		const run = runScript(99);

		expect(run.status).toBe(1);
		expect(run.installs).toHaveLength(3);
		expect(run.output).toContain("::error title=bun install failed::all 3 attempts failed");
		expect(run.summary).toContain("failed all 3 attempts");
	});
});

describe("build.yml installs through the retry action", () => {
	const yaml = () => readFileSync(buildYml, "utf8");

	it("has install sites to check at all", () => {
		expect(yaml().match(/\.github\/actions\/bun-install/g)?.length ?? 0).toBeGreaterThan(0);
	});

	it("keeps the frozen-lockfile install frozen", () => {
		// terminal_e2e installed with --frozen-lockfile; routing it through the action
		// must not quietly relax that into a lockfile-updating install.
		expect(yaml().match(/frozen-lockfile: "true"/g)).toHaveLength(1);
		expect(readFileSync(resolve(repoRoot, ".github/actions/bun-install/action.yml"), "utf8")).toContain(
			"install-with-retry.sh",
		);
	});

	it("never calls bun install directly", () => {
		const direct = yaml()
			.split("\n")
			.map((line, index) => ({ line: line.trim(), number: index + 1 }))
			.filter(({ line }) => /^(run:\s*)?bun install\b/.test(line) || /^-?\s*run:\s*bun install\b/.test(line));

		expect(
			direct.map(({ line, number }) => `build.yml:${number} ${line}`),
			"A bare `bun install` in build.yml dies on a transient registry tarball failure and fails an unrelated PR. Fix: use `- uses: ./.github/actions/bun-install`.",
		).toEqual([]);
	});
});
