import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SessionLockRuntime,
	SessionLockTimeoutError,
	type SessionLockProcessEvidence,
	type SessionLockProcessEvidenceAdapter,
	withOwnedSessionState,
	withSessionStateLock,
} from "../session-lock";
import {
	NATIVE_SESSIONS_DIR_ENV,
	NATIVE_SESSION_LOCKS_DIR_ENV,
	sessionDir,
	sessionLockFile,
	sessionLocksRootDir,
	tokenFile,
} from "../paths";

const SELF_SIGNATURE = `${process.pid}@test-process`;

function evidence(status: SessionLockProcessEvidence): SessionLockProcessEvidenceAdapter {
	return {
		inspect: async (pid) => (pid === process.pid ? { status: "alive", startSignature: SELF_SIGNATURE } : status),
	};
}

function lockOptions(processEvidence: SessionLockProcessEvidenceAdapter) {
	return { processEvidence, staleAfterMs: 0, timeoutMs: 25, pollMs: 1 };
}

function staleRecord(generation = "a".repeat(64), pid = 999_999): string {
	return `${JSON.stringify({
		version: 1,
		generation,
		pid,
		startSignature: `${pid}@old-process`,
		createdAtMs: 1,
	})}\n`;
}

describe("generation-owned native session lock", () => {
	let root = "";
	const saved = { ...process.env };

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-session-lock-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = join(root, "sessions");
		process.env[NATIVE_SESSION_LOCKS_DIR_ENV] = join(root, "locks");
	});

	afterEach(() => {
		process.env = { ...saved };
		try {
			chmodSync(sessionLocksRootDir(), 0o700);
		} catch {
			// The test may not have created the root.
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("breaks an old lock only after definitive dead-process evidence", async () => {
		mkdirSync(sessionLocksRootDir(), { recursive: true });
		writeFileSync(sessionLockFile("alpha", "canonical"), staleRecord());

		const value = await withSessionStateLock("alpha", () => "entered", lockOptions(evidence({ status: "dead" })));

		expect(value).toBe("entered");
		expect(readdirSync(sessionLocksRootDir())).toEqual([]);
	});

	it("breaks a lock whose pid was definitively reused", async () => {
		mkdirSync(sessionLocksRootDir(), { recursive: true });
		writeFileSync(sessionLockFile("alpha", "canonical"), staleRecord());
		const reused = evidence({ status: "alive", startSignature: "999999@new-process" });

		expect(await withSessionStateLock("alpha", () => true, lockOptions(reused))).toBe(true);
		expect(readdirSync(sessionLocksRootDir())).toEqual([]);
	});

	it("never steals an old lock from a live matching process", async () => {
		mkdirSync(sessionLocksRootDir(), { recursive: true });
		writeFileSync(sessionLockFile("alpha", "canonical"), staleRecord());
		const live = evidence({ status: "alive", startSignature: "999999@old-process" });

		await expect(withSessionStateLock("alpha", () => true, lockOptions(live))).rejects.toBeInstanceOf(
			SessionLockTimeoutError,
		);
		expect(readFileSync(sessionLockFile("alpha", "canonical"), "utf8")).toBe(staleRecord());
	});

	it("does not enter when a blocking claim appears between the final scan and canonical link", async () => {
		let inserted = false;
		let entered = false;
		const generation = "d".repeat(64);
		const runtime = new SessionLockRuntime({
			afterClaimScanBeforeCanonicalLink: async () => {
				if (inserted) return;
				inserted = true;
				writeFileSync(
					sessionLockFile("alpha", "claim", generation),
					staleRecord(generation, process.pid).replace(`${process.pid}@old-process`, SELF_SIGNATURE),
				);
			},
		});

		await expect(
			runtime.withSessionStateLock(
				"alpha",
				() => {
					entered = true;
				},
				lockOptions(evidence({ status: "dead" })),
			),
		).rejects.toBeInstanceOf(SessionLockTimeoutError);
		expect(entered).toBe(false);
		expect(existsSync(sessionLockFile("alpha", "claim", generation))).toBe(true);
	});

	it("fails closed when process identity cannot be established", async () => {
		mkdirSync(sessionLocksRootDir(), { recursive: true });
		writeFileSync(sessionLockFile("alpha", "canonical"), staleRecord());

		await expect(
			withSessionStateLock("alpha", () => true, lockOptions(evidence({ status: "unknown" }))),
		).rejects.toBeInstanceOf(SessionLockTimeoutError);
		expect(existsSync(sessionLockFile("alpha", "canonical"))).toBe(true);
	});

	it("retires only its own generation when a successor appears before release", async () => {
		const successor = staleRecord("b".repeat(64), 777_777);
		await withSessionStateLock(
			"alpha",
			() => {
				const canonical = sessionLockFile("alpha", "canonical");
				const owner = JSON.parse(readFileSync(canonical, "utf8")) as { generation: string };
				renameSync(canonical, sessionLockFile("alpha", "claim", "c".repeat(64)));
				writeFileSync(canonical, successor);
				expect(owner.generation).not.toBe("b".repeat(64));
			},
			lockOptions(evidence({ status: "dead" })),
		);

		expect(readFileSync(sessionLockFile("alpha", "canonical"), "utf8")).toBe(successor);
		expect(readdirSync(sessionLocksRootDir())).toEqual(["alpha.canonical.lock"]);
	});

	it("keeps the lock outside a session directory that the critical section deletes", async () => {
		mkdirSync(sessionDir("alpha"), { recursive: true });
		writeFileSync(join(sessionDir("alpha"), "owned"), "x");

		await withSessionStateLock(
			"alpha",
			() => rmSync(sessionDir("alpha"), { recursive: true }),
			lockOptions(evidence({ status: "dead" })),
		);

		expect(existsSync(sessionDir("alpha"))).toBe(false);
		expect(readdirSync(sessionLocksRootDir())).toEqual([]);
	});

	it("releases only the current session family", async () => {
		mkdirSync(sessionLocksRootDir(), { recursive: true });
		writeFileSync(sessionLockFile("beta", "canonical"), "foreign-family");

		await withSessionStateLock("alpha", () => undefined, lockOptions(evidence({ status: "dead" })));

		expect(readFileSync(sessionLockFile("beta", "canonical"), "utf8")).toBe("foreign-family");
		expect(readdirSync(sessionLocksRootDir())).toEqual(["beta.canonical.lock"]);
	});

	it("reports both callback and generation-release failures", async () => {
		let thrown: unknown;
		try {
			await withSessionStateLock(
				"alpha",
				() => {
					chmodSync(sessionLocksRootDir(), 0o500);
					throw new Error("callback failed");
				},
				lockOptions(evidence({ status: "dead" })),
			);
		} catch (error) {
			thrown = error;
		} finally {
			chmodSync(sessionLocksRootDir(), 0o700);
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors.map(String).join("\n")).toContain("callback failed");
	});

	it("rejects invalid ids before creating any lock-root state", async () => {
		await expect(
			withSessionStateLock("../escape", () => true, lockOptions(evidence({ status: "dead" }))),
		).rejects.toThrow("invalid native session id");
		expect(existsSync(sessionLocksRootDir())).toBe(false);
	});
});

describe("owned native session mutation", () => {
	let root = "";
	const saved = { ...process.env };

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-owned-session-"));
		process.env[NATIVE_SESSIONS_DIR_ENV] = join(root, "sessions");
		process.env[NATIVE_SESSION_LOCKS_DIR_ENV] = join(root, "locks");
		mkdirSync(sessionDir("alpha"), { recursive: true });
		writeFileSync(tokenFile("alpha"), "token-a", { mode: 0o600 });
	});

	afterEach(() => {
		process.env = { ...saved };
		rmSync(root, { recursive: true, force: true });
	});

	it("validates the token once inside the lock, then applies a bounded synchronous mutation", async () => {
		const result = await withOwnedSessionState(
			"alpha",
			"token-a",
			() => {
				rmSync(tokenFile("alpha"));
				writeFileSync(join(sessionDir("alpha"), "applied"), "yes");
				return 42;
			},
			lockOptions(evidence({ status: "dead" })),
		);

		expect(result).toEqual({ kind: "applied", value: 42 });
		expect(readFileSync(join(sessionDir("alpha"), "applied"), "utf8")).toBe("yes");
	});

	it("rejects an old owner without running its queued publisher", async () => {
		let ran = false;
		const result = await withOwnedSessionState(
			"alpha",
			"old-token",
			() => {
				ran = true;
			},
			lockOptions(evidence({ status: "dead" })),
		);

		expect(result).toEqual({ kind: "session-replaced" });
		expect(ran).toBe(false);
	});

	it("does not recreate a removed session for an old queued publisher", async () => {
		rmSync(sessionDir("alpha"), { recursive: true });

		const result = await withOwnedSessionState(
			"alpha",
			"token-a",
			() => mkdirSync(sessionDir("alpha"), { recursive: true }),
			lockOptions(evidence({ status: "dead" })),
		);

		expect(result).toEqual({ kind: "session-replaced" });
		expect(existsSync(sessionDir("alpha"))).toBe(false);
	});
});
