import { describe, it, expect } from "vitest";
import { createSpawnMock, GIT_ENV } from "./git-test-helpers";

// Regression guard for the git-suite flake: a spawn that never starts used to raise
// an uncaught `error` event AND leave `exited` pending forever, so the awaiting test
// died on the 5s suite timeout — attributed to whichever test happened to be running.
describe("createSpawnMock", () => {
	it("resolves exited with a non-zero code when the binary cannot be spawned", async () => {
		const { spawn } = createSpawnMock();

		const proc = spawn(["dev3-definitely-not-a-real-binary", "--version"]);

		await expect(proc.exited).resolves.toBe(1);
	});

	it("yields empty output streams for a spawn that never started", async () => {
		const { spawn } = createSpawnMock();

		const proc = spawn(["dev3-definitely-not-a-real-binary"]);
		await proc.exited;

		await expect(new Response(proc.stdout).text()).resolves.toBe("");
		await expect(new Response(proc.stderr).text()).resolves.toBe("");
	});

	it("resolves exited when the cwd no longer exists", async () => {
		const { spawn } = createSpawnMock();

		const proc = spawn(["git", "status"], { cwd: "/tmp/dev3-removed-by-a-previous-test" });

		await expect(proc.exited).resolves.toBeGreaterThan(0);
	});

	it("neutralises the machine's git config", () => {
		expect(GIT_ENV.GIT_CONFIG_GLOBAL).toBe("/dev/null");
		expect(GIT_ENV.GIT_CONFIG_NOSYSTEM).toBe("1");
	});
});
