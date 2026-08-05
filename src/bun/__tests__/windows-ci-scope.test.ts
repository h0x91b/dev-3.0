/**
 * `WINDOWS_SCOPE_PATHS` decides whether the required `test` context waits for the
 * packaged Windows jobs or asserts they were deliberately not needed. That makes
 * the list and its matcher load-bearing in a way the old YAML filter was not: a
 * miss no longer means "Windows quietly did not run", it means "Windows was
 * checked-and-not-applicable" on a green required check. See decisions/209.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	WINDOWS_SCOPE_PATHS,
	matchesWindowsScope,
	windowsScopeHits,
} from "../../shared/windows-ci-scope";

const SCRIPT = fileURLToPath(new URL("../../../scripts/windows-ci-scope.ts", import.meta.url));

describe("windows CI scope matching", () => {
	it("matches an exact path entry", () => {
		expect(matchesWindowsScope("src/bun/pty-server.ts")).toBe(true);
		expect(matchesWindowsScope("electrobun.config.ts")).toBe(true);
	});

	it("matches anything under a /** entry, at any depth", () => {
		expect(matchesWindowsScope("src/bun/native-terminal-host/index.ts")).toBe(true);
		expect(matchesWindowsScope("src/bun/native-terminal-host/nested/deep/file.ts")).toBe(true);
	});

	it("does not match a sibling that merely shares a prefix", () => {
		expect(matchesWindowsScope("src/bun/pty-server-extra.ts")).toBe(false);
		expect(matchesWindowsScope("src/bun/native-terminal-hostess.ts")).toBe(false);
	});

	it("leaves renderer-only changes out of scope", () => {
		// PR #1263 vs #1259: renderer-only PRs are ~1 in 5 and must not pay 5 minutes.
		expect(
			windowsScopeHits([
				"src/mainview/components/TaskCard.tsx",
				"src/mainview/index.css",
				"change-logs/2026/08/06/fix-something.md",
			]),
		).toEqual([]);
	});

	it("puts a change to the scope list itself in scope", () => {
		// Otherwise a wrong list could be shipped by a PR that judged itself irrelevant.
		expect(matchesWindowsScope("src/shared/windows-ci-scope.ts")).toBe(true);
		expect(matchesWindowsScope("scripts/windows-ci-scope.ts")).toBe(true);
	});

	it("has no duplicate entries", () => {
		expect(new Set(WINDOWS_SCOPE_PATHS).size).toBe(WINDOWS_SCOPE_PATHS.length);
	});
});

describe("windows-ci-scope script", () => {
	function run(input: string, args: string[] = []) {
		return spawnSync("bun", [SCRIPT, ...args], { input, encoding: "utf8" });
	}

	it("reports in scope when a packaging file changed", () => {
		const result = run("src/bun/pty-server.ts\nsrc/mainview/App.tsx\n");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("in scope: true");
		expect(result.stdout).toContain("hit: src/bun/pty-server.ts");
	});

	it("reports out of scope when nothing matched", () => {
		const result = run("src/mainview/App.tsx\n");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("in scope: false");
	});

	it("fails instead of assuming out of scope when it has no file list", () => {
		// The coordinator's rule: if the thing deciding scope cannot decide, the
		// answer is not "fine". An empty list must never print in scope: false.
		const result = run("");
		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("in scope: false");
		expect(result.stderr).toContain("could not be decided");
	});
});
