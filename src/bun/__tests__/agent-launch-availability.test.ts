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
		vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-omp": process.execPath } } as never);
		expect(await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: null }])).toBeNull();
	});

	it("reports the agent missing when its custom path is broken, even though the binary is on PATH", async () => {
		installedBinaries.add("omp");
		vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-omp": "/gone/omp" }, strictAgentCustomBinaryPaths: { "builtin-omp": "/gone/omp" } } as never);
		expect((await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: null }]))?.agentId).toBe("builtin-omp");
	});

	it("does not block on a gone custom path saved before paths became strict: the launch uses PATH", async () => {
		installedBinaries.add("omp");
		vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-omp": "/gone/omp" } } as never);
		expect(await findMissingLaunchAgent([{ agentId: "builtin-omp", configId: null }])).toBeNull();
	});

	it("judges a path-shaped command by that path, not by a same-named binary on PATH", async () => {
		getAllAgentsSpy.mockResolvedValueOnce([{ ...claudeAgent, baseCommand: "/nowhere/dev3-test/claude" }]);
		const missing = await findMissingLaunchAgent([{ agentId: "builtin-claude", configId: "claude-default" }]);
		expect(missing?.binaryName).toBe("claude");
	});

	// GitHub issue #2218: the executable is `opencode`, never `opencode mini`.
	describe.skipIf(process.platform === "win32")("a base command with more than the executable", () => {
		const withOverride = (baseCommandOverride: string) => {
			getAllAgentsSpy.mockResolvedValueOnce([{
				...claudeAgent,
				configurations: [{ id: "claude-default", name: "Default", baseCommandOverride }],
			}]);
			return findMissingLaunchAgent([{ agentId: "builtin-claude", configId: "claude-default" }]);
		};

		it("launches `env <absolute path> <subcommand>` when that path is executable", async () => {
			expect(await withOverride(`env '${process.execPath}' mini`)).toBeNull();
		});

		it("names only the executable when that path is missing", async () => {
			expect((await withOverride("env /nowhere/dev3-test/opencode mini"))?.binaryName).toBe("opencode");
		});

		it("looks a wrapped name up on PATH without its subcommand", async () => {
			installedBinaries.add("opencode");
			expect(await withOverride("env FOO=1 opencode mini")).toBeNull();
			expect((await withOverride("FOO=1 not-installed-cli mini"))?.binaryName).toBe("not-installed-cli");
		});

		it("judges a multi-word command by its first program", async () => {
			installedBinaries.add("npx");
			expect(await withOverride("npx my-claude --flag")).toBeNull();
		});

		it("never blocks a command only the shell can resolve", async () => {
			expect(await withOverride("$HOME/bin/opencode mini")).toBeNull();
			expect(await withOverride("exec opencode mini")).toBeNull();
			expect(await withOverride("./bin/opencode mini")).toBeNull();
		});

		it("still reports a broken custom path for a command it cannot resolve", async () => {
			vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-claude": "/gone/claude" }, strictAgentCustomBinaryPaths: { "builtin-claude": "/gone/claude" } } as never);
			expect((await withOverride("exec opencode mini"))?.customPath).toBe("/gone/claude");
		});
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
	it("names a broken custom executable instead of claiming the agent is not installed", async () => {
		installedBinaries.add("omp");
		vi.mocked(loadSettings).mockResolvedValueOnce({ agentCustomBinaryPaths: { "builtin-omp": "/gone/omp" }, strictAgentCustomBinaryPaths: { "builtin-omp": "/gone/omp" } } as never);
		const error = await assertLaunchAgentsInstalled([{ agentId: "builtin-omp" }]).catch((e) => e);
		expect(error).toBeInstanceOf(AgentNotInstalledError);
		expect(String(error)).toContain('Custom executable for agent "Oh My Pi" not found or not executable: /gone/omp');
		expect(String(error)).not.toContain("not found on PATH");
	});

	it("throws an error the renderer can recognise across RPC", async () => {
		const error = await assertLaunchAgentsInstalled([{ agentId: "builtin-omp" }]).catch((e) => e);
		expect(error).toBeInstanceOf(AgentNotInstalledError);
		expect(isAgentNotInstalledError(String(error))).toBe(true);
		expect(String(error)).toContain("Oh My Pi is not installed on the machine running dev3");
	});
});
