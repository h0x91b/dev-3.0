import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BUN = /(?:^|\/)bun$/.test(process.execPath) ? process.execPath : "bun";
const MAIN = resolve(import.meta.dirname, "../main.ts");

/** main.ts exits before `dev3 message` runs when no app is found, so only a real process shows the wiring. */
function runWithNoApp(args: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "dev3-msg-noapp-"));
	const env: Record<string, string | undefined> = { ...process.env, DEV3_HOME: join(dir, "home") };
	delete env.DEV3_CLI_SOCKET;
	delete env.DEV3_TASK_ID;
	return spawnSync(BUN, [MAIN, ...args], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
}

describe("dev3 message --json with no app to discover", () => {
	it("still prints one not-delivered verdict before exiting 2", () => {
		const res = runWithNoApp(["message", "--json", "--task", "seq:1", "--subject", "s", "hi"]);
		expect(res.status).toBe(2);
		expect(JSON.parse(res.stdout)).toEqual({ status: "not-delivered", messageId: null });
	});

	it("prints nothing on stdout without --json", () => {
		const res = runWithNoApp(["message", "--task", "seq:1", "--subject", "s", "hi"]);
		expect(res.status).toBe(2);
		expect(res.stdout).toBe("");
	});
});
