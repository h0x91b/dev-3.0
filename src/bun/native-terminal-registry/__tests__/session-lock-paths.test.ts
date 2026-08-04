/**
 * Where session-lock state lives, and what must never see it. Lock artifacts in
 * the sessions root would be read as sessions; inside a session directory they
 * would keep it alive through teardown.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	NATIVE_SESSIONS_DIR_ENV,
	NATIVE_SESSION_LOCKS_DIR_ENV,
	parseSessionLockFile,
	SESSION_LOCK_PATTERN,
	sessionDir,
	sessionLockFile,
	sessionLocksRootDir,
	sessionsRootDir,
} from "../paths";
import { n2SessionDirs } from "./n2-fixtures/n2-reader";

const GENERATION = "a".repeat(64);

describe("session lock root resolution", () => {
	const saved = { ...process.env };

	afterEach(() => {
		process.env = { ...saved };
	});

	it("defaults to its own top-level sibling of the sessions root", () => {
		delete process.env[NATIVE_SESSIONS_DIR_ENV];
		delete process.env[NATIVE_SESSION_LOCKS_DIR_ENV];
		process.env.DEV3_HOME = "/home/example/.dev3.0";
		expect(sessionLocksRootDir()).toBe("/home/example/.dev3.0/native-session-locks");
		// Never inside the sessions root, and never inside a session directory.
		expect(sessionLocksRootDir().startsWith(sessionsRootDir())).toBe(false);
		expect(dirname(sessionLockFile("alpha", "canonical"))).not.toBe(sessionDir("alpha"));
	});

	it("honours its own override exactly", () => {
		process.env[NATIVE_SESSION_LOCKS_DIR_ENV] = "/tmp/explicit-locks";
		expect(sessionLocksRootDir()).toBe("/tmp/explicit-locks");
	});

	it("derives beside a sessions override, so an isolated run cannot reach the real home", () => {
		delete process.env[NATIVE_SESSION_LOCKS_DIR_ENV];
		process.env.DEV3_HOME = "/home/example/.dev3.0";
		process.env[NATIVE_SESSIONS_DIR_ENV] = "/tmp/run-42/sessions";
		expect(sessionLocksRootDir()).toBe("/tmp/run-42/sessions-locks");
		// A trailing separator must not produce a doubled one.
		process.env[NATIVE_SESSIONS_DIR_ENV] = "/tmp/run-42/sessions/";
		expect(sessionLocksRootDir()).toBe("/tmp/run-42/sessions-locks");
		expect(sessionLocksRootDir()).not.toContain("/home/example");
	});

	it("prefers its own override over a derived one", () => {
		process.env[NATIVE_SESSIONS_DIR_ENV] = "/tmp/run-42/sessions";
		process.env[NATIVE_SESSION_LOCKS_DIR_ENV] = "/tmp/explicit-locks";
		expect(sessionLocksRootDir()).toBe("/tmp/explicit-locks");
	});
});

describe("session lock family paths", () => {
	const saved = { ...process.env };

	beforeEach(() => {
		process.env[NATIVE_SESSION_LOCKS_DIR_ENV] = "/tmp/locks-root";
	});

	afterEach(() => {
		process.env = { ...saved };
	});

	it("keeps every member a direct sibling under the locks root", () => {
		for (const member of ["candidate", "claim"] as const) {
			const file = sessionLockFile("alpha", member, GENERATION);
			expect(dirname(file)).toBe("/tmp/locks-root");
			expect(SESSION_LOCK_PATTERN.test(file.slice("/tmp/locks-root/".length))).toBe(true);
		}
		// The published lock needs no generation in its name.
		expect(sessionLockFile("alpha", "canonical")).toBe("/tmp/locks-root/alpha.canonical.lock");
		expect(SESSION_LOCK_PATTERN.test("alpha.canonical.lock")).toBe(true);
		expect(SESSION_LOCK_PATTERN.test(`alpha.one.claim.${GENERATION}.lock`)).toBe(true);
	});

	it("rejects a session id that could escape the locks root", () => {
		for (const bad of ["../../escape", "a/b", "", ".", "with space", "x".repeat(65)]) {
			expect(() => sessionLockFile(bad, "canonical")).toThrow();
		}
	});

	it("matches every member of the family and nothing else", () => {
		expect(SESSION_LOCK_PATTERN.test("alpha.canonical.lock")).toBe(true);
		expect(SESSION_LOCK_PATTERN.test(`alpha.candidate.${GENERATION}.lock`)).toBe(true);
		expect(SESSION_LOCK_PATTERN.test(`alpha.claim.${GENERATION}.lock`)).toBe(true);
		for (const other of [
			"alpha",
			"record.json",
			"alpha.lock",
			"alpha.canonical.json",
			"alpha.other.lock",
			"alpha.candidate.lock",
			`alpha.canonical.${GENERATION}.lock`,
		]) {
			expect(SESSION_LOCK_PATTERN.test(other)).toBe(false);
		}
	});

	it("parses a Windows-style claim path without treating it as canonical", () => {
		expect(parseSessionLockFile(`C:\\locks\\alpha.claim.${GENERATION}.lock`)).toEqual({
			sessionId: "alpha",
			member: "claim",
			generation: GENERATION,
		});
	});
});

describe("enumerators never see a lock as a session", () => {
	let root = "";
	const saved = { ...process.env };

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-lock-paths-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = join(root, "sessions");
		delete process.env[NATIVE_SESSION_LOCKS_DIR_ENV];
		mkdirSync(sessionsRootDir(), { recursive: true });
		mkdirSync(sessionLocksRootDir(), { recursive: true });
		mkdirSync(sessionDir("alpha"), { recursive: true });
		writeFileSync(sessionLockFile("alpha", "canonical"), "{}");
		writeFileSync(sessionLockFile("alpha", "candidate", GENERATION), "{}");
		writeFileSync(sessionLockFile("alpha", "claim", GENERATION), "{}");
	});

	afterEach(() => {
		process.env = { ...saved };
		rmSync(root, { recursive: true, force: true });
	});

	it("leaves the sessions root containing only real sessions", () => {
		// This is the whole reason the locks root is a separate tree: every enumerator
		// of the sessions root, current or released, lists its entries as sessions.
		expect(n2SessionDirs(sessionsRootDir())).toEqual(["alpha"]);
	});

	it("keeps lock state out of the session directory, so teardown can remove it", () => {
		rmSync(sessionDir("alpha"), { recursive: true, force: true });
		// The lock family survives its session's directory, which is what lets a holder
		// keep the lock across the deletion it is performing.
		expect(n2SessionDirs(sessionsRootDir())).toEqual([]);
		expect(n2SessionDirs(sessionLocksRootDir())).toEqual([]); // files, not directories
	});

	it("touches no unrelated root", () => {
		const unrelated = join(root, "worktrees");
		mkdirSync(unrelated, { recursive: true });
		writeFileSync(join(unrelated, "keep-me"), "x");
		expect(sessionLocksRootDir().startsWith(unrelated)).toBe(false);
		expect(n2SessionDirs(unrelated)).toEqual([]);
	});
});
