/**
 * The narrow guard on the no-tmux escape hatch (seq 1381).
 *
 * `hasTmuxSessionOrAbsent` exists so a native-backend E2E can assert "no tmux
 * session was created" on a runner with no tmux binary. The danger is obvious:
 * widen that catch by one inch and every real tmux failure becomes a silent
 * pass, which is the worst possible outcome for an assertion whose whole job is
 * to prove tmux was never touched. These tests pin the boundary — exactly one
 * error class is absorbed, everything else propagates.
 */
import { describe, it, expect, vi } from "vitest";

import { hasTmuxSessionOrAbsent, type SessionProbe } from "./tmux-session-probe";
import { TmuxError, TmuxSpawnError } from "../tmux/errors";

const SESSION = "dev3-task-abc";

/** A probe that always fails with `err`. */
function failing(err: unknown): SessionProbe {
	return () => Promise.reject(err);
}

describe("hasTmuxSessionOrAbsent — the honest answers", () => {
	it("reports a live session as present", async () => {
		await expect(hasTmuxSessionOrAbsent(async () => true, SESSION)).resolves.toBe(true);
	});

	it("reports a missing session as absent", async () => {
		await expect(hasTmuxSessionOrAbsent(async () => false, SESSION)).resolves.toBe(false);
	});

	it("passes the socket through only when one was given", async () => {
		const probe = vi.fn(async () => false);
		await hasTmuxSessionOrAbsent(probe, SESSION, "throwaway");
		await hasTmuxSessionOrAbsent(probe, SESSION);
		expect(probe.mock.calls).toEqual([
			[SESSION, { socket: "throwaway" }],
			[SESSION, undefined],
		]);
	});
});

describe("hasTmuxSessionOrAbsent — absorbs ONLY an unlaunchable tmux", () => {
	// No tmux binary is the strongest evidence that no tmux session exists, so
	// this is the one case that may answer the question instead of failing.
	it("treats a spawn failure as absence", async () => {
		const err = new TmuxSpawnError("tmux", new Error('Executable not found in $PATH: "tmux"'));
		await expect(hasTmuxSessionOrAbsent(failing(err), SESSION)).resolves.toBe(false);
	});

	// The client tags its errors by name so a duplicated class across module
	// boundaries still matches — the guard must rely on the same tag.
	it("treats a name-tagged spawn failure as absence even without instanceof", async () => {
		const err = Object.assign(new Error("tmux failed to spawn"), { name: "TmuxSpawnError" });
		await expect(hasTmuxSessionOrAbsent(failing(err), SESSION)).resolves.toBe(false);
	});
});

describe("hasTmuxSessionOrAbsent — everything else must still fail the caller", () => {
	// tmux ran and refused. That says nothing about whether a session exists, so
	// answering "absent" would convert "could not look" into "looked, all clean".
	it("rethrows a non-zero exit (TmuxError)", async () => {
		const err = new TmuxError(["has-session", "-t", SESSION], 1, "permission denied");
		await expect(hasTmuxSessionOrAbsent(failing(err), SESSION)).rejects.toThrow("permission denied");
	});

	it("rethrows a permission failure that is not a spawn failure", async () => {
		const err = Object.assign(new Error("EACCES: permission denied, open '/tmp/tmux-501'"), { code: "EACCES" });
		await expect(hasTmuxSessionOrAbsent(failing(err), SESSION)).rejects.toThrow("EACCES");
	});

	it("rethrows malformed output / parse failures", async () => {
		await expect(
			hasTmuxSessionOrAbsent(failing(new SyntaxError("unexpected tmux output")), SESSION),
		).rejects.toThrow(SyntaxError);
	});

	it("rethrows an arbitrary unexpected error", async () => {
		await expect(hasTmuxSessionOrAbsent(failing(new Error("boom")), SESSION)).rejects.toThrow("boom");
	});

	it("rethrows a non-Error throw instead of reading it as absence", async () => {
		await expect(hasTmuxSessionOrAbsent(failing("tmux exploded"), SESSION)).rejects.toBe("tmux exploded");
	});

	// A near-miss name must not sneak through the tag-based fallback.
	it("rethrows an error whose name merely resembles the spawn failure", async () => {
		const err = Object.assign(new Error("close but no"), { name: "TmuxSpawnErrorish" });
		await expect(hasTmuxSessionOrAbsent(failing(err), SESSION)).rejects.toThrow("close but no");
	});
});
