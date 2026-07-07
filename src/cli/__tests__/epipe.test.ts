import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_EXIT_CODE_INTERNAL_ERROR } from "../../shared/cli-exit-codes";
import { isEpipeError } from "../epipe";

const FIXTURE = resolve(import.meta.dirname, "fixtures/epipe-writer.ts");
// vitest runs this suite under node, but the fixture is TS importing project
// source — run it with bun (the project runtime; on PATH via setup-bun in CI).
const BUN = /(?:^|\/)bun$/.test(process.execPath) ? process.execPath : "bun";

/**
 * Run the writer fixture through a real shell pipe into `head -c`, which reads a
 * little then closes its read end — exactly `dev3 … | head`. The writer's next
 * write to the now-broken pipe hits EPIPE. We capture the WRITER's exit code
 * (PIPESTATUS[0], not head's) and its stderr, so we can tell a clean exit from a
 * raw broken-pipe crash.
 */
function runBrokenPipe(guard: boolean): { code: number; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), "dev3-epipe-"));
	const errFile = join(dir, "stderr.txt");
	try {
		const cmd =
			`${JSON.stringify(BUN)} ${JSON.stringify(FIXTURE)}${guard ? " --guard" : ""} ` +
			`2>${JSON.stringify(errFile)} | head -c 200 >/dev/null; echo \${PIPESTATUS[0]}`;
		const res = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
		return { code: Number(res.stdout.trim()), stderr: readFileSync(errFile, "utf8") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("isEpipeError", () => {
	it("recognizes an EPIPE-coded error", () => {
		expect(isEpipeError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
		expect(isEpipeError({ code: "EPIPE" })).toBe(true);
	});

	it("rejects non-EPIPE and non-object values", () => {
		expect(isEpipeError(Object.assign(new Error("nope"), { code: "ECONNRESET" }))).toBe(false);
		expect(isEpipeError(new Error("plain"))).toBe(false);
		expect(isEpipeError(null)).toBe(false);
		expect(isEpipeError(undefined)).toBe(false);
		expect(isEpipeError("EPIPE")).toBe(false);
	});
});

describe("broken-pipe guard (subprocess)", () => {
	// The control run proves the pipeline actually triggers a broken pipe — so a
	// green guarded run below means "handled", not "EPIPE never happened".
	it("crashes with a raw EPIPE trace WITHOUT the guard (control)", () => {
		const { code, stderr } = runBrokenPipe(false);
		expect(stderr).toContain("EPIPE");
		expect(code).not.toBe(0);
	}, 20_000);

	it("exits 0 silently WITH the guard", () => {
		const { code, stderr } = runBrokenPipe(true);
		expect(code).toBe(0);
		expect(stderr).toBe("");
	}, 20_000);

	// A guarded process must NOT swallow non-EPIPE crashes as success, and must
	// exit with the documented internal-error code (4) — rethrowing from the
	// uncaughtException listener would make Bun exit 7, colliding with
	// CLI_EXIT_CODE_DOCTOR_PROBLEMS.
	it("prints non-EPIPE uncaught exceptions and exits with the internal-error code", () => {
		const res = spawnSync(BUN, [FIXTURE, "--guard", "--boom"], { encoding: "utf8" });
		expect(res.stderr).toContain("boom-not-epipe");
		expect(res.status).toBe(CLI_EXIT_CODE_INTERNAL_ERROR);
	}, 20_000);
});
