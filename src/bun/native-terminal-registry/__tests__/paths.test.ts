import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	assertValidSessionId,
	isValidSessionId,
	journalFile,
	NATIVE_SESSIONS_DIR_ENV,
	recordFile,
	sessionDir,
	sessionsRootDir,
	tokenFile,
} from "../paths";

describe("native-session registry paths", () => {
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env[NATIVE_SESSIONS_DIR_ENV];
	});
	afterEach(() => {
		if (prev === undefined) delete process.env[NATIVE_SESSIONS_DIR_ENV];
		else process.env[NATIVE_SESSIONS_DIR_ENV] = prev;
	});

	it("honours the namespace override for every per-session path", () => {
		process.env[NATIVE_SESSIONS_DIR_ENV] = "/tmp/does-not-matter-native-sessions";
		const root = "/tmp/does-not-matter-native-sessions";
		expect(sessionsRootDir()).toBe(root);
		expect(sessionDir("abc")).toBe(join(root, "abc"));
		expect(recordFile("abc")).toBe(join(root, "abc", "record.json"));
		expect(tokenFile("abc")).toBe(join(root, "abc", "token"));
		expect(journalFile("abc")).toBe(join(root, "abc", "journal.ndjson"));
	});

	it("defaults to an additive native-sessions dir under DEV3_HOME", () => {
		delete process.env[NATIVE_SESSIONS_DIR_ENV];
		const prevHome = process.env.DEV3_HOME;
		process.env.DEV3_HOME = "/tmp/dev3home-native";
		expect(sessionsRootDir()).toBe(join("/tmp/dev3home-native", "native-sessions"));
		if (prevHome === undefined) delete process.env.DEV3_HOME;
		else process.env.DEV3_HOME = prevHome;
	});

	it("accepts safe stable session ids", () => {
		for (const id of ["a", "task-123", "A.B_c-9", "x".repeat(64)]) {
			expect(isValidSessionId(id)).toBe(true);
		}
	});

	it("rejects traversal, separators, empties, and over-long ids", () => {
		for (const id of ["", ".", "..", "a/b", "a\\b", "../etc", "a..b", ".hidden", "x".repeat(65), "a b"]) {
			expect(isValidSessionId(id)).toBe(false);
		}
	});

	it("assertValidSessionId throws on an unsafe id and passes a safe one", () => {
		expect(() => assertValidSessionId("../escape")).toThrow("invalid native session id");
		expect(() => assertValidSessionId("ok-1")).not.toThrow();
	});
});
