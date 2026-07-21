import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../launcher";

describe("detached host launcher diagnostics", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-launcher-diagnostic-"));
		process.env.DEV3_PTY_PROTO_DIR = root;
	});

	afterEach(() => {
		delete process.env.DEV3_PTY_PROTO_DIR;
		rmSync(root, { recursive: true, force: true });
	});

	it("surfaces the detached host log when startup exits early", async () => {
		const failingHost = fileURLToPath(new URL("./fixtures/failing-host.mjs", import.meta.url));

		await expect(start({ timeoutMs: 3000, hostEntryPath: failingHost })).rejects.toThrow(
			"PACKAGED_RUNTIME_FAILURE: update or reinstall dev3",
		);
	});
});
