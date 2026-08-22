/**
 * `applyUpdate` against a real temp tree: what a brew apply leaves for a rollback,
 * and what a HALF-DONE tarball apply must not leave behind.
 *
 * `renameSync` is the one thing mocked, because failing on the Nth entry is the
 * whole scenario and there is no way to provoke it from the filesystem alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdatePlan } from "../../shared/self-update";

const TEST_HOME = vi.hoisted(() => {
	const base = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
	return `${base}/dev3-self-update-apply-${process.pid}`;
});
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

// Spread the real module so only `renameSync` is ours; `renameFailsOn` is set per
// test and matches on the DESTINATION path.
const fsControl = vi.hoisted(() => ({ renameFailsOn: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		default: real,
		renameSync: (from: string, to: string) => {
			if (fsControl.renameFailsOn && to.endsWith(fsControl.renameFailsOn)) {
				throw new Error(`EXDEV: refusing to rename ${to}`);
			}
			return real.renameSync(from, to);
		},
	};
});

import { spawn } from "../spawn";
import { _resetStagingMemo, applyUpdate, stageUpdate } from "../self-update";
import { REMOTE_ROLLBACK_DIR } from "../remote-state";

const mockSpawn = vi.mocked(spawn);

function fakeChild(): unknown {
	return { pid: 1, stdout: new Response("").body, stderr: new Response("").body, exited: Promise.resolve(0), unref: () => {} };
}

const BREW: UpdatePlan = { kind: "brew", version: "1.46.0", cask: false, command: ["brew", "upgrade", "dev3"] };

const SANDBOX = `${TEST_HOME}/sandbox`;
const INSTALL = `${SANDBOX}/install`;
const VIEWS = `${SANDBOX}/views`;

/** An install dir with three entries, and a staged tree replacing all three. */
function seedTarballApply(): { dir: string; stagedDir: string } {
	mkdirSync(INSTALL, { recursive: true });
	const stagedDir = join(INSTALL, ".dev3-staged");
	mkdirSync(stagedDir, { recursive: true });
	for (const [name, body] of [["artifact-template", "old"], ["dev3", "old"], ["dist", "old"]] as const) {
		writeFileSync(join(INSTALL, name), body);
		writeFileSync(join(stagedDir, name), "new");
	}
	return { dir: INSTALL, stagedDir };
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetStagingMemo();
	fsControl.renameFailsOn = null;
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(SANDBOX, { recursive: true });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockSpawn.mockImplementation(() => fakeChild() as any);
});

afterEach(() => {
	_resetStagingMemo();
	rmSync(TEST_HOME, { recursive: true, force: true });
	delete process.env.DEV3_VIEWS_DIR;
});

describe("a brew apply leaves a rollback that can actually serve", () => {
	// `<installDir>/dist` is a path, not a snapshot: brew replaces the whole keg, so by
	// rollback time it holds the NEW bundle. Leaving `fallbackViews` null instead was
	// worse — the rollback binary sits in `~/.dev3.0/remote/rollback/`, where none of
	// the successor's probe candidates resolve, so the box came back reachable and
	// served an empty page.
	it("copies the renderer bundle aside, not just the binary", async () => {
		mkdirSync(VIEWS, { recursive: true });
		writeFileSync(join(VIEWS, "index.html"), "<html>old</html>");
		process.env.DEV3_VIEWS_DIR = VIEWS;

		const result = await applyUpdate({ plan: BREW });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.applied.fallbackViews).toBe(join(REMOTE_ROLLBACK_DIR, "dist"));
		expect(readFileSync(join(result.applied.fallbackViews as string, "index.html"), "utf-8"))
			.toBe("<html>old</html>");
	});

	// A bundle we cannot find must not cost the binary too: the box still comes back,
	// it just serves nothing until somebody fixes the install by hand.
	it("still hands back a binary when there is no bundle to copy", async () => {
		process.env.DEV3_VIEWS_DIR = join(SANDBOX, "does-not-exist");

		const result = await applyUpdate({ plan: BREW });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.applied.fallbackBin).toBe(join(REMOTE_ROLLBACK_DIR, "dev3"));
		expect(result.applied.fallbackViews).toBeNull();
	});
});

describe("a tarball apply that fails halfway", () => {
	it("puts the install dir back the way it was", async () => {
		const { dir, stagedDir } = seedTarballApply();
		fsControl.renameFailsOn = "/dist";

		const result = await applyUpdate({ plan: { kind: "tarball", version: "1.46.0", url: "x" }, stagedDir }, dir);

		expect(result.ok).toBe(false);
		expect(readFileSync(join(dir, "dev3"), "utf-8")).toBe("old");
		expect(readFileSync(join(dir, "artifact-template"), "utf-8")).toBe("old");
	});

	// The entries that made it across were MOVED out of `.dev3-staged`, and
	// `reusableStaged` only checks that a `dev3` is still in there — so a failure on an
	// entry ordered AFTER `dev3` left a tree that passed the check, and the next
	// attempt would install the new binary against the OLD `dist`.
	it("does not leave a partial staged tree for the next attempt to reuse", async () => {
		const { dir, stagedDir } = seedTarballApply();
		fsControl.renameFailsOn = "/dist";
		const plan: UpdatePlan = { kind: "tarball", version: "1.46.0", url: "https://example.invalid/x.tar.gz" };

		await applyUpdate({ plan, stagedDir }, dir);

		expect(existsSync(stagedDir)).toBe(false);
		// And the memo is gone with it: the next stage must go back to the network
		// rather than hand back the half-tree. (Nothing serves that URL, hence a failure
		// — the point is that it TRIED.)
		const restaged = await stageUpdate(plan);
		expect(restaged.ok).toBe(false);
	});
});
