import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

let tmp: string;
let worktree: string;
const originalDev3Home = process.env.DEV3_HOME;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "dev3-codex-symlink-"));
	process.env.DEV3_HOME = tmp;
	worktree = join(tmp, "worktrees", "proj", "abcd1234", "worktree");
	mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
	if (originalDev3Home === undefined) delete process.env.DEV3_HOME;
	else process.env.DEV3_HOME = originalDev3Home;
	rmSync(tmp, { recursive: true, force: true });
});

describe("setupAgentHooks for codex", () => {
	it("returns the trust bypass when dev3 wrote the hooks", async () => {
		expect(await setupAgentHooks(worktree, "codex")).toEqual({ flag: "--dangerously-bypass-hook-trust" });
	});

	it("does not bypass hook trust when .codex links outside the worktree", async () => {
		const kit = join(tmp, "kit");
		mkdirSync(kit);
		symlinkSync(kit, join(worktree, ".codex"));
		expect(await setupAgentHooks(worktree, "codex")).toBeNull();
	});
});
