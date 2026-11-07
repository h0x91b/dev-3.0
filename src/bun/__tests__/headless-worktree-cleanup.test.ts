import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const TARBALL_SCRIPT = fileURLToPath(new URL("../../../scripts/create-cli-tarball.sh", import.meta.url));
const HEADLESS_ENTRY = fileURLToPath(new URL("../headless-entry.ts", import.meta.url));
const BACKGROUND_SCHEDULERS = fileURLToPath(new URL("../background-schedulers.ts", import.meta.url));

// h0x91b/dev-3.0#2183: a `dev3 remote` install never ran the daily task-file cleanup.
describe("daily worktree cleanup on a headless install", () => {
	it("is started by the headless entry, and stopped on shutdown", () => {
		const source = readFileSync(HEADLESS_ENTRY, "utf-8");
		expect(source, "headless-entry must start the schedulers like index.ts does").toMatch(/^startBackgroundSchedulers\(/m);
		const shutdown = source.slice(source.indexOf("function shutdown("));
		expect(shutdown).toContain("stopBackgroundSchedulers();");
		const shared = readFileSync(BACKGROUND_SCHEDULERS, "utf-8");
		expect(shared).toMatch(/^\tstartWorktreeCleanupScheduler\(\);$/m);
		expect(shared).toMatch(/^\t\tstopWorktreeCleanupScheduler,$/m);
	});
});

describe.skipIf(process.platform === "win32")("create-cli-tarball.sh", () => {
	let root: string | null = null;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = null;
	});

	function stage(withWorkers: boolean): string {
		root = mkdtempSync(join(tmpdir(), "dev3-cli-tarball-"));
		mkdirSync(join(root, "dist", "assets"), { recursive: true });
		mkdirSync(join(root, "src", "assets", "artifact-template"), { recursive: true });
		writeFileSync(join(root, "dist", "dev3"), "#!/bin/sh\n");
		writeFileSync(join(root, "dist", "index.html"), "<html></html>");
		writeFileSync(join(root, "src", "assets", "artifact-template", "AUTHORING.md"), "x");
		if (withWorkers) {
			mkdirSync(join(root, "dist", "workers"), { recursive: true });
			writeFileSync(join(root, "dist", "workers", "worktree-cleanup-worker.js"), "//");
			writeFileSync(join(root, "dist", "workers", "conversation-handoff-worker.js"), "//");
		}
		return root;
	}

	const pack = (cwd: string) => spawnSync("bash", [TARBALL_SCRIPT, "linux", "x64"], { cwd, encoding: "utf-8" });

	it("ships the worker bundles the headless server loads from dist/workers", () => {
		const cwd = stage(true);
		const result = pack(cwd);
		expect(result.status, result.stderr + result.stdout).toBe(0);
		const listing = spawnSync("tar", ["-tzf", join(cwd, "artifacts-linux-x64", "dev3-cli-linux-x64.tar.gz")], { encoding: "utf-8" }).stdout;
		expect(listing).toContain("./dist/workers/worktree-cleanup-worker.js");
		expect(listing).toContain("./dist/workers/conversation-handoff-worker.js");
	});

	it("refuses to package a tarball without them", () => {
		const result = pack(stage(false));
		expect(result.status).not.toBe(0);
		expect(result.stdout + result.stderr).toContain("dist/workers missing");
	});
});
