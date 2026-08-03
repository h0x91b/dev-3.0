import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalFile, NATIVE_SESSIONS_DIR_ENV, parserStateFile, recordFile, sessionDir, tokenFile } from "../paths";
import {
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	NATIVE_SESSION_SCHEMA_VERSION,
	parseRecord,
	readRecord,
	readToken,
	removeSessionState,
	serializeRecord,
	writeRecordAtomic,
	writeToken,
	type NativeSessionRecord,
} from "../record";

function sample(overrides: Partial<NativeSessionRecord> = {}): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: "alpha",
		paneId: "alpha:0",
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "darwin",
		host: { pid: 4242, executable: "/bin/bun", startSignature: "4242@t0" },
		shell: { pid: 4243, command: ["/bin/bash"], startSignature: "4243@t0" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
		...overrides,
	};
}

describe("native-session record — optional capture capability (seq 1412)", () => {
	it("round-trips the capability a parser-enabled host advertises", () => {
		const record = sample({ capabilities: { capture: NATIVE_SESSION_CAPTURE_CAPABILITY } });
		expect(parseRecord(serializeRecord(record))?.capabilities).toEqual({
			capture: NATIVE_SESSION_CAPTURE_CAPABILITY,
		});
	});

	it("stays absent for a host that publishes no screen — which IS the answer", () => {
		// Absence is the load-bearing half: it is how a reader says "not enabled" as
		// a fact rather than inferring it from silence.
		expect(parseRecord(serializeRecord(sample()))).not.toHaveProperty("capabilities");
	});

	it("is readable by a build that predates the field — no schema bump, no migration", () => {
		const raw = JSON.parse(serializeRecord(sample())) as Record<string, unknown>;
		raw.capabilities = { capture: NATIVE_SESSION_CAPTURE_CAPABILITY };
		const parsed = parseRecord(JSON.stringify(raw));
		expect(parsed?.schemaVersion).toBe(NATIVE_SESSION_SCHEMA_VERSION);
		expect(parsed?.sessionId).toBe("alpha");
		expect(parsed?.host.startSignature).toBe("4242@t0");
	});

	it("drops an unrecognised capability instead of losing the whole session", () => {
		for (const capabilities of [
			{ capture: "semantic-snapshot-v2" },
			{ capture: true },
			{ capture: "" },
			"not-an-object",
			42,
			null,
		]) {
			const raw = JSON.parse(serializeRecord(sample())) as Record<string, unknown>;
			raw.capabilities = capabilities;
			const parsed = parseRecord(JSON.stringify(raw));
			// The session survives; the unknown capability lands on "not enabled",
			// which is the safe side — a caller reads less than the host can do.
			expect(parsed?.sessionId).toBe("alpha");
			expect(parsed).not.toHaveProperty("capabilities");
		}
	});
});

describe("native-session record — optional identity (seq 1383)", () => {
	it("round-trips a task-owned identity", () => {
		const record = sample({ identity: { seq: "1383", paneId: "pane-1" } });
		expect(parseRecord(serializeRecord(record))).toEqual(record);
	});

	it("stays absent for a session started outside a task", () => {
		expect(parseRecord(serializeRecord(sample()))).not.toHaveProperty("identity");
	});

	it("is readable by a build that never wrote it — no schema bump", () => {
		// A pre-1383 dev3 parses the same schemaVersion 1 whitelist, so an unknown
		// key must never make a record unreadable-and-not-ours.
		const raw = JSON.parse(serializeRecord(sample())) as Record<string, unknown>;
		raw.identity = { seq: "1383", paneId: "pane-1" };
		raw.somethingFromTheFuture = { nested: true };
		const parsed = parseRecord(JSON.stringify(raw));
		expect(parsed?.sessionId).toBe("alpha");
		expect(parsed).not.toHaveProperty("somethingFromTheFuture");
	});

	it("drops a malformed identity instead of losing the whole session", () => {
		for (const identity of [
			"1383",
			42,
			null,
			{ seq: 1383 },
			{ seq: "Fix the auth race" },
			{ seq: "../../etc/passwd" },
			{ paneId: "pane 1; rm -rf /" },
			{},
		]) {
			const raw = JSON.parse(serializeRecord(sample())) as Record<string, unknown>;
			raw.identity = identity;
			const parsed = parseRecord(JSON.stringify(raw));
			expect(parsed?.sessionId).toBe("alpha");
			expect(parsed?.identity).toBeUndefined();
		}
	});

	it("keeps a half-known identity rather than discarding the readable half", () => {
		const raw = JSON.parse(serializeRecord(sample())) as Record<string, unknown>;
		raw.identity = { seq: "1383", paneId: 7 };
		expect(parseRecord(JSON.stringify(raw))?.identity).toEqual({ seq: "1383" });
	});
});

describe("native-session record (pure)", () => {
	it("round-trips a valid record", () => {
		expect(parseRecord(serializeRecord(sample()))).toEqual(sample());
	});

	it("returns null for corrupt JSON, wrong schema, and missing/mistyped fields", () => {
		expect(parseRecord("{ not json")).toBeNull();
		expect(parseRecord(serializeRecord(sample({ schemaVersion: 999 as never })))).toBeNull();
		expect(parseRecord(JSON.stringify({ ...sample(), host: { pid: "x" } }))).toBeNull();
		expect(parseRecord(JSON.stringify({ ...sample(), endpoint: { transport: "tcp", address: "127.0.0.1", port: 1 } }))).toBeNull();
		expect(parseRecord(JSON.stringify({ ...sample(), ownership: { evidenceKind: "guess" } }))).toBeNull();
	});

	it("refuses to surface a record that smuggled in a token field", () => {
		const withToken = { ...sample(), token: "leaked-secret" };
		expect(parseRecord(JSON.stringify(withToken))).toBeNull();
	});

	it("never serialises a token into record.json", () => {
		expect(serializeRecord(sample())).not.toContain("token");
	});
});

describe("native-session record (on disk)", () => {
	let root: string;
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env[NATIVE_SESSIONS_DIR_ENV];
		root = mkdtempSync(join(tmpdir(), "dev3-native-record-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = root;
	});
	afterEach(() => {
		if (prev === undefined) delete process.env[NATIVE_SESSIONS_DIR_ENV];
		else process.env[NATIVE_SESSIONS_DIR_ENV] = prev;
		rmSync(root, { recursive: true, force: true });
	});

	it("atomically writes and reads a record", () => {
		writeRecordAtomic(sample());
		expect(readRecord("alpha")).toEqual(sample());
		expect(readRecord("missing")).toBeNull();
	});

	it("keeps the token in a private sibling file, never in the record", () => {
		writeRecordAtomic(sample());
		writeToken("alpha", "top-secret-token");
		expect(readToken("alpha")).toBe("top-secret-token");
		expect(readFileSync(recordFile("alpha"), "utf8")).not.toContain("top-secret-token");
	});

	it("removeSessionState only deletes token-matched state", () => {
		writeRecordAtomic(sample());
		writeToken("alpha", "tok-A");

		// A stale caller with the wrong token cannot erase a newer session.
		expect(removeSessionState("alpha", "tok-WRONG")).toBe(false);
		expect(readRecord("alpha")).not.toBeNull();
		expect(existsSync(tokenFile("alpha"))).toBe(true);

		// The rightful owner clears everything, record removed last.
		expect(removeSessionState("alpha", "tok-A")).toBe(true);
		expect(readRecord("alpha")).toBeNull();
		expect(existsSync(sessionDir("alpha"))).toBe(false);
	});

	it("removes only atomic temp files owned by the recorded crashed host", () => {
		writeRecordAtomic(sample());
		writeToken("alpha", "tok-A");
		const targets = [recordFile("alpha"), tokenFile("alpha"), journalFile("alpha"), parserStateFile("alpha")];
		for (const target of targets) writeFileSync(`${target}.4242.tmp`, "partial");
		const foreignTemp = `${journalFile("alpha")}.9999.tmp`;
		writeFileSync(foreignTemp, "leave-me");

		expect(removeSessionState("alpha", "tok-A")).toBe(true);
		for (const target of targets) expect(existsSync(`${target}.4242.tmp`)).toBe(false);
		expect(existsSync(foreignTemp)).toBe(true);
	});

	it("removeSessionState fails closed when no expected token is available", () => {
		writeRecordAtomic(sample());
		expect(removeSessionState("alpha", null)).toBe(false);
		expect(readRecord("alpha")).not.toBeNull();
	});

	it("ignores a corrupt record on read", () => {
		writeRecordAtomic(sample());
		writeFileSync(recordFile("alpha"), "{ half written");
		expect(readRecord("alpha")).toBeNull();
	});
});
