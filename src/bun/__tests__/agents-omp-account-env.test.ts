import { mkdirSync } from "node:fs";
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
});
