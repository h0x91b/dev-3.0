/**
 * The two things about staging and relaunching that only show up when a child
 * process is actually spawned: that two callers cannot race the same staging
 * paths, and that a views dir we guessed for ourselves does not travel to the
 * successor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdatePlan } from "../../shared/self-update";

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

import { spawn } from "../spawn";
import { _resetStagingMemo, spawnDetached, stageUpdate, VIEWS_DIR_AUTO_ENV } from "../self-update";

const mockSpawn = vi.mocked(spawn);

/** A child that succeeds immediately, with the shape `runCapture` reads. */
function fakeChild(): unknown {
	return {
		pid: 4242,
		stdout: new Response("").body,
		stderr: new Response("").body,
		exited: Promise.resolve(0),
		unref: () => {},
	};
}

const BREW: UpdatePlan = { kind: "brew", version: "1.46.0", cask: false, command: ["brew", "upgrade", "dev3"] };

function commandsRun(): string[][] {
	return mockSpawn.mock.calls.map((call) => call[0] as string[]);
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetStagingMemo();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockSpawn.mockImplementation(() => fakeChild() as any);
});

afterEach(() => {
	_resetStagingMemo();
	delete process.env[VIEWS_DIR_AUTO_ENV];
	delete process.env.DEV3_VIEWS_DIR;
});

describe("stageUpdate is serialised", () => {
	// `.dev3-staged{,.tar.gz}` are the SAME two paths for every plan, and the reuse
	// memo is only set after success — so the watch's pre-stage and a Restart press
	// both missed it and ran concurrently, one `rmSync` truncating the other's
	// extract. The only guard before the apply is "is there a `dev3` in there",
	// which a half-extracted tree passes.
	it("runs one stage for two concurrent callers on the same plan", async () => {
		const [a, b] = await Promise.all([stageUpdate(BREW), stageUpdate(BREW)]);

		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		expect(commandsRun().filter((cmd) => cmd[1] === "fetch")).toHaveLength(1);
	});

	it("still stages a DIFFERENT plan, once the paths are free again", async () => {
		const other: UpdatePlan = { kind: "brew", version: "1.47.0", cask: false, command: ["brew", "upgrade", "dev3"] };

		const [a, b] = await Promise.all([stageUpdate(BREW), stageUpdate(other)]);

		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		expect(commandsRun().filter((cmd) => cmd[1] === "fetch")).toHaveLength(2);
	});
});

describe("spawnDetached and the inherited views dir", () => {
	const logFile = join(tmpdir(), `dev3-self-update-test-${process.pid}.log`);

	function envOfLastSpawn(): Record<string, string | undefined> {
		const calls = mockSpawn.mock.calls;
		const opts = calls[calls.length - 1][1] as { env: Record<string, string | undefined> };
		return opts.env;
	}

	// headless-entry probes `dist/` and writes the answer into the environment; every
	// child inherits it twice over (`src/bun/spawn.ts` re-merges `process.env`). A brew
	// formula upgrade puts the new build in a NEW keg, so the successor would serve the
	// predecessor's bundle — and the same leak silently undoes `fallbackViews: null`.
	it("blanks a views dir we resolved ourselves", () => {
		process.env.DEV3_VIEWS_DIR = "/opt/homebrew/Cellar/dev3/1.45.2/share/dev-3.0/dist";
		process.env[VIEWS_DIR_AUTO_ENV] = "1";

		spawnDetached("/bin/true", ["remote", "start"], {}, logFile);

		expect(envOfLastSpawn().DEV3_VIEWS_DIR).toBe("");
		expect(envOfLastSpawn()[VIEWS_DIR_AUTO_ENV]).toBe("");
	});

	it("keeps a views dir the caller passed on purpose — that is the rollback path", () => {
		process.env.DEV3_VIEWS_DIR = "/new/keg/dist";
		process.env[VIEWS_DIR_AUTO_ENV] = "1";

		spawnDetached("/bin/true", ["remote", "start"], { DEV3_VIEWS_DIR: "/prev/dist" }, logFile);

		expect(envOfLastSpawn().DEV3_VIEWS_DIR).toBe("/prev/dist");
	});

	it("leaves an operator's own views dir alone", () => {
		process.env.DEV3_VIEWS_DIR = "/home/me/checkout/dist";

		spawnDetached("/bin/true", ["remote", "start"], {}, logFile);

		expect(envOfLastSpawn().DEV3_VIEWS_DIR).toBe("/home/me/checkout/dist");
	});
});
