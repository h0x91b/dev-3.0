import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLaunchScript } from "../rpc-handlers/shared-pure";

// The dev-server wrapper exports `--env` values verbatim into a shared temp dir.
describe.skipIf(process.platform === "win32")("writeLaunchScript private", () => {
	let root: string;
	let modeWhenBodyLanded: number | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-launch-script-"));
		modeWhenBodyLanded = null;
		vi.stubGlobal("Bun", {
			write: async (path: string, body: string) => {
				modeWhenBodyLanded = statSync(path, { throwIfNoEntry: false })?.mode ?? null;
				writeFileSync(path, body);
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(root, { recursive: true, force: true });
	});

	it("locks a world-readable leftover down before the body is written", async () => {
		const path = join(root, "dev.sh");
		writeFileSync(path, "old", "utf-8");
		chmodSync(path, 0o644);

		await writeLaunchScript(path, "export SECRET_TOKEN=abc\n", { private: true });

		expect(modeWhenBodyLanded! & 0o777).toBe(0o600);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf-8")).toContain("SECRET_TOKEN=abc");
	});

	it("leaves an ordinary script's mode alone", async () => {
		const path = join(root, "agent.sh");
		writeFileSync(path, "old", "utf-8");
		chmodSync(path, 0o644);

		await writeLaunchScript(path, "echo hi\n");

		expect(statSync(path).mode & 0o777).toBe(0o644);
	});
});
