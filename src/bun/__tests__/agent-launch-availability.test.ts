import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgent } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const ompAgent: CodingAgent = {
	id: "builtin-omp",
	name: "Oh My Pi",
	baseCommand: "omp",
	installCommand: "curl -fsSL https://omp.sh/install | sh",
	configurations: [{ id: "omp-default", name: "Default" }],
	defaultConfigId: "omp-default",
};
const claudeAgent: CodingAgent = {
	id: "builtin-claude",
	name: "Claude",
	baseCommand: "claude",
	configurations: [
		{ id: "claude-default", name: "Default" },
		{ id: "claude-wrapper", name: "Wrapper", baseCommandOverride: "my-claude" },
	],
	defaultConfigId: "claude-default",
};

// The async wrapper hands out a promise the spy never observes — vi.fn attaches
// handlers to its own return value, which would hide an unhandled rejection.
const getAllAgentsSpy = vi.fn(async () => [ompAgent, claudeAgent]);
vi.mock("../agents", () => ({
	getAllAgents: async () => await getAllAgentsSpy(),
	findConfig: (agent: CodingAgent, configId: string | null | undefined) =>
		agent.configurations.find((c) => c.id === configId) ?? agent.configurations[0],
}));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ defaultAgentId: "builtin-claude", defaultConfigId: "claude-default" })),
}));
const installedBinaries = new Set<string>();
vi.mock("../rpc-handlers/shared-pure", () => ({
	resolveBinaryPath: vi.fn((name: string, override?: string) => ({
		resolvedPath: override ?? (installedBinaries.has(name) ? `/usr/local/bin/${name}` : undefined),
		customPathError: false,
	})),
}));

import { loadSettings } from "../settings";
import { AgentNotInstalledError, assertLaunchAgentsInstalled, findMissingLaunchAgent } from "../agent-launch-availability";
import { isAgentNotInstalledError } from "../../shared/agent-install";

beforeEach(() => {
	installedBinaries.clear();
	installedBinaries.add("claude");
});

describe("findMissingLaunchAgent", () => {
	it("reports a missing harness with its install command", async () => {
		const missing = await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: "omp-default" }]);
		expect(missing).toEqual({
			agentId: "builtin-omp",
			agentName: "Oh My Pi",
			binaryName: "omp",
			installCommand: process.platform === "win32" ? "irm https://omp.sh/install.ps1 | iex" : "curl -fsSL https://omp.sh/install | sh",
		});
	});

	it("leaves an installed harness alone", async () => {
		expect(await findMissingLaunchAgent([{ agentId: "builtin-claude", configId: null }])).toBeNull();
	});

	it("finds the missing one in a mixed group", async () => {
		const missing = await findMissingLaunchAgent([
			{ agentId: "builtin-claude", configId: null },
			{ agentId: "builtin-omp", configId: null },
		]);
		expect(missing?.agentId).toBe("builtin-omp");
	});

	it("resolves a null agent to the user's default, as the launch does", async () => {
		vi.mocked(loadSettings).mockResolvedValueOnce({ defaultAgentId: "builtin-omp" } as never);
		expect((await findMissingLaunchAgent([{ agentId: null, configId: null }]))?.agentId).toBe("builtin-omp");
	});

	it("judges a preset's own base command, not its agent's", async () => {
		const missing = await findMissingLaunchAgent([{ agentId: "builtin-claude", configId: "claude-wrapper" }]);
		expect(missing?.binaryName).toBe("my-claude");
	});

	it("honours a custom binary path saved for that agent", async () => {
		vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-omp": "/opt/omp/bin/omp" } } as never);
		expect(await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: null }])).toBeNull();
	});

	it("judges a path-shaped command by that path, not by a same-named binary on PATH", async () => {
		getAllAgentsSpy.mockResolvedValueOnce([{ ...claudeAgent, baseCommand: "/nowhere/dev3-test/claude" }]);
		const missing = await findMissingLaunchAgent([{ agentId: "builtin-claude", configId: "claude-default" }]);
		expect(missing?.binaryName).toBe("claude");
	});

	it("never blocks when the PATH lookup throws", async () => {
		const { resolveBinaryPath } = await import("../rpc-handlers/shared-pure");
		vi.mocked(resolveBinaryPath).mockImplementationOnce(() => { throw new Error("which crashed"); });
		expect(await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: null }])).toBeNull();
	});

	it("leaves no unhandled rejection when settings throw synchronously", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			vi.mocked(loadSettings).mockImplementationOnce(() => { throw new Error("no loadSettings"); });
			getAllAgentsSpy.mockImplementationOnce(() => Promise.reject(new Error("agents also failed")));
			expect(await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: null }])).toBeNull();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("never blocks when the probe itself fails", async () => {
		getAllAgentsSpy.mockRejectedValueOnce(new Error("agents.json unreadable"));
		expect(await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: null }])).toBeNull();
	});
});

describe("assertLaunchAgentsInstalled", () => {
	it("throws an error the renderer can recognise across RPC", async () => {
		const error = await assertLaunchAgentsInstalled([{ agentId: "builtin-omp" }]).catch((e) => e);
		expect(error).toBeInstanceOf(AgentNotInstalledError);
		expect(isAgentNotInstalledError(String(error))).toBe(true);
		expect(String(error)).toContain("Oh My Pi is not installed on the machine running dev3");
	});
});
