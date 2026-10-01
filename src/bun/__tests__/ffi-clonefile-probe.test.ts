import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../spawn", () => ({ spawn: () => ({ exited: Promise.resolve(0), stderr: undefined }) }));
vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { configureClonefileWorker } from "../cow-clone";
import { probeClonefile } from "../../../scripts/ffi-clonefile-probe";

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf-8");

// The release gate once ran cow-clone without a worker, so after clonefile moved
// into one every macOS build (canary and stable) failed on a `cp -cR` result.
describe("ffi clonefile release probe", () => {
	const origPlatform = process.platform;
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ffi-probe-"));
		Object.defineProperty(process, "platform", { value: "darwin", writable: true });
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
		configureClonefileWorker(null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes only when the clone went through the given worker", async () => {
		const worker = join(dir, "ok.cjs");
		writeFileSync(worker, `require("node:worker_threads").parentPort.postMessage({ ok: true });\n`);

		await expect(probeClonefile("/src", "/dst", worker)).resolves.toBeUndefined();
	});

	it("fails when the worker bundle is missing instead of accepting the cp fallback", async () => {
		await expect(probeClonefile("/src", "/dst", join(dir, "missing.js"))).rejects.toThrow(
			"expected clonefile, got apfs-clone",
		);
	});

	it("is what the macOS release gate compiles, fed the worker the app ships", () => {
		const workflow = repoFile(".github/workflows/release-build-macos.yml");
		expect(workflow).toContain("bun build scripts/ffi-clonefile-probe.ts --compile");
		expect(workflow).toContain('-path "*/Resources/app/workers/clonefile-worker.js"');
		expect(workflow).toContain('"$PROBE_DIR/probe" "$PROBE_DIR/src" "$PROBE_DIR/dest" "$WORKER_JS"');
		expect(repoFile("electrobun.config.ts")).toContain('"dist/workers": "workers"');
	});
});
