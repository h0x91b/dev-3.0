import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../codex-config", () => ({
	CODEX_HOOK_TRUST_BYPASS_FLAG: "--dangerously-bypass-hook-trust",
	detectCodexHookTrustBypass: vi.fn(async () => true),
	resetCodexHelpProbe: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { setupAgentHooks } from "../agent-hooks";

let tempHome: string;
let worktree: string;
const originalDev3Home = process.env.DEV3_HOME;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "dev3-omp-launch-"));
	worktree = join(tempHome, "wt");
	process.env.DEV3_HOME = tempHome;
});

afterEach(() => {
	if (originalDev3Home === undefined) delete process.env.DEV3_HOME;
	else process.env.DEV3_HOME = originalDev3Home;
	rmSync(tempHome, { recursive: true, force: true });
});

describe("setupAgentHooks for omp", () => {
	it("writes the status extension under the dev3 home and returns the --hook flag", async () => {
		const flag = await setupAgentHooks(worktree, "omp");
		const expected = join(tempHome, "data", "agent-hooks", "omp-status.ts");
		expect(flag).toBe(`--hook ${expected}`);
		expect(existsSync(expected)).toBe(true);
		// Nothing lands in the worktree: the module is one shared artifact.
		expect(existsSync(join(worktree, ".omp"))).toBe(false);
	});

	it("resolves a wrapper script through the declared family", async () => {
		const flag = await setupAgentHooks(worktree, "/opt/bin/my-omp-wrapper", { family: "omp" });
		expect(flag?.startsWith("--hook ")).toBe(true);
	});

	it("still installs nothing for agents without hooks", async () => {
		expect(await setupAgentHooks(worktree, "gemini")).toBeNull();
	});
});
