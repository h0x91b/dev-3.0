import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ agentsLayoutRevision: 10, agentBinaryPaths: {}, agentCustomBinaryPaths: {} })),
	saveSettings: vi.fn(async () => undefined),
}));
vi.mock("../agent-accounts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../agent-accounts")>()),
	getActiveOmpSessionEnv: vi.fn(async () => ({})),
}));

import { getActiveOmpSessionEnv } from "../agent-accounts";
import { resolveCommandForAgent } from "../agents";
import { DEV3_HOME } from "../paths";

const ctx = { taskTitle: "t", taskDescription: "d", projectName: "p", projectPath: "/p", worktreePath: "/w" };
const mockedOmpEnv = vi.mocked(getActiveOmpSessionEnv);

beforeAll(() => mkdirSync(DEV3_HOME, { recursive: true }));
beforeEach(() => mockedOmpEnv.mockReset());

describe("omp account env at launch", () => {
	it("hands the selected account's agent dir to omp", async () => {
		mockedOmpEnv.mockResolvedValue({ PI_CODING_AGENT_DIR: "/accounts/omp/a1" });
		const resolved = await resolveCommandForAgent("builtin-omp", null, ctx, { accountId: "a1" });
		expect(mockedOmpEnv).toHaveBeenCalledWith("a1");
		expect(resolved.extraEnv.PI_CODING_AGENT_DIR).toBe("/accounts/omp/a1");
	});

	it("never consults the omp registry for another harness", async () => {
		await resolveCommandForAgent("builtin-codex", null, ctx, { accountId: "a1" });
		expect(mockedOmpEnv).not.toHaveBeenCalled();
	});

	it("defaults omp to Nerd Font symbols unless the account's config sets them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-acct-"));
		try {
			mockedOmpEnv.mockResolvedValue({ PI_CODING_AGENT_DIR: dir });
			const fresh = await resolveCommandForAgent("builtin-omp", null, ctx, { accountId: "a1" });
			expect(fresh.command).toMatch(/--config \S*omp-defaults\.yml/);

			writeFileSync(join(dir, "config.yml"), "symbolPreset: ascii\n");
			const chosen = await resolveCommandForAgent("builtin-omp", null, ctx, { accountId: "a1" });
			expect(chosen.command).not.toContain("--config");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("launches a live-model pick with that model and the preset's own mode", async () => {
		const resolved = await resolveCommandForAgent("builtin-omp", "omp-yolo-high|model=openai-codex/gpt-6.1-sol", ctx, {});
		expect(resolved.command).toContain("--model openai-codex/gpt-6.1-sol");
		expect(resolved.command).toContain("--approval-mode yolo");
		expect(resolved.command).toContain("--thinking high");
	});
});

describe("retired agent defaults", () => {
	it("moves an install still on omp's old shipped default, and only that", async () => {
		const { migrateRetiredAgentDefaults } = await import("../agents");
		const omp = { id: "builtin-omp", name: "Oh My Pi", baseCommand: "omp", configurations: [] };
		const [moved, kept, other] = migrateRetiredAgentDefaults([
			{ ...omp, defaultConfigId: "omp-default" },
			{ ...omp, defaultConfigId: "omp-write" },
			{ id: "builtin-codex", name: "Codex", baseCommand: "codex", configurations: [], defaultConfigId: "omp-default" },
		]);
		expect(moved.defaultConfigId).toBe("omp-yolo");
		expect(kept.defaultConfigId).toBe("omp-write");
		expect(other.defaultConfigId).toBe("omp-default");
	});
});
