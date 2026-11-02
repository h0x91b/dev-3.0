import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock spawn before importing the module under test: resolveModelAvailability
// spawns the agent CLI, and the test drives its stdout/exit code.
vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

// The Codex account env resolution does real fs/registry reads; stub it so the
// test controls which CODEX_HOME each account maps to.
vi.mock("../agent-accounts", () => ({
	getActiveCodexSessionEnv: vi.fn(async () => ({})),
}));

// The probe resolves the launch binary via these; stub them so no settings file
// or the heavy agents module is loaded, and the binary passes through unchanged.
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ agentBinaryPaths: {}, agentCustomBinaryPaths: {} })),
}));
vi.mock("../agents", () => ({
	applyBinaryPathOverride: vi.fn((agent: CodingAgent) => agent),
}));
// The Codex auth gate asks the shared sign-in rule about one home; drive it.
vi.mock("../harness-readiness", () => ({ codexHomeSignedIn: vi.fn(() => true) }));

import { resolveModelAvailability, clearAvailableModelsCache } from "../agent-available-models";
import { codexAdapter } from "../../shared/agent-adapters/codex";
import { cursorAdapter } from "../../shared/agent-adapters/cursor";
import { spawn } from "../spawn";
import { getActiveCodexSessionEnv } from "../agent-accounts";
import { applyBinaryPathOverride } from "../agents";
import { codexHomeSignedIn } from "../harness-readiness";
import type { CodingAgent } from "../../shared/types";

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockCodexSessionEnv = getActiveCodexSessionEnv as unknown as ReturnType<typeof vi.fn>;
const mockApplyBinaryPathOverride = applyBinaryPathOverride as unknown as ReturnType<typeof vi.fn>;
const mockCodexHomeSignedIn = codexHomeSignedIn as unknown as ReturnType<typeof vi.fn>;

/** A fake Bun subprocess whose stdout is a fixed string. */
function fakeProc(stdout: string, exitCode = 0) {
	return { stdout, exited: Promise.resolve(exitCode), kill: vi.fn() };
}

function codexAgent(models: string[]): CodingAgent {
	return {
		id: "builtin-codex",
		name: "Codex",
		baseCommand: "codex",
		configurations: models.map((model, i) => ({ id: `c${i}`, name: model, model })),
	};
}

const CODEX_DUMP = JSON.stringify({
	models: [
		{ slug: "gpt-6-astra", visibility: "list", supported_in_api: true },
		{ slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true },
		{ slug: "gpt-5.4", visibility: "hide", supported_in_api: true },
		{ slug: "gpt-api-only", visibility: "list", supported_in_api: false },
	],
});

beforeEach(() => {
	vi.clearAllMocks();
	clearAvailableModelsCache();
	mockCodexSessionEnv.mockResolvedValue({});
	mockApplyBinaryPathOverride.mockImplementation((agent: CodingAgent) => agent);
	mockCodexHomeSignedIn.mockReturnValue(true); // codex home is logged in by default
	delete process.env.OPENAI_API_KEY;
});

describe("codex modelListProbe.parse", () => {
	const parse = codexAdapter.modelListProbe!.parse;

	it("keeps only visibility=list AND supported_in_api slugs", () => {
		expect(parse(CODEX_DUMP)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
	});

	it("returns null on non-JSON so a broken dump filters nothing", () => {
		expect(parse("not json")).toBeNull();
	});

	it("returns null when there is no models array", () => {
		expect(parse(JSON.stringify({ foo: 1 }))).toBeNull();
	});

	it("has no normalize — Codex compares on the exact base slug", () => {
		expect(codexAdapter.modelListProbe!.normalize).toBeUndefined();
	});
});

describe("cursor modelListProbe", () => {
	const probe = cursorAdapter.modelListProbe!;

	it("parses `slug - Display Name` rows and skips the header", () => {
		const out = "Available models\n\nauto - Auto (default)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\n";
		expect(probe.parse(out)).toEqual(["auto", "gpt-5.6-sol-high"]);
	});

	it("normalize folds effort/speed suffixes to the base family", () => {
		const n = probe.normalize!;
		expect(n("gpt-5.6-sol-xhigh")).toBe("gpt-5.6-sol");
		expect(n("gpt-5.6-sol-high")).toBe("gpt-5.6-sol");
		expect(n("cursor-grok-4.6-high-fast")).toBe("cursor-grok-4.6");
		expect(n("claude-opus-5-thinking-high")).toBe("claude-opus-5");
		// A slug with no effort suffix is left whole.
		expect(n("composer-2.5")).toBe("composer-2.5");
	});

	it("strips ANSI escapes the real CLI emits on stdout", () => {
		// cursor-agent clears the line / moves the cursor and colours rows even when
		// piped; the slug must survive that.
		const out = "\u001B[2K\u001B[GAvailable models\n\n\u001B[1mauto\u001B[0m - Auto\n\u001B[32mgpt-5.6-sol-high\u001B[0m - GPT-5.6 Sol\n";
		expect(probe.parse(out)).toEqual(["auto", "gpt-5.6-sol-high"]);
	});
});

describe("resolveModelAvailability", () => {
	it("flags Codex preset models the account cannot select", async () => {
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent = codexAgent(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"]);
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
	});

	it("returns unknown and probes nothing when the custom executable is broken", async () => {
		mockApplyBinaryPathOverride.mockImplementation(() => {
			throw new Error("Custom executable for agent \"Codex\" not found or not executable: /gone");
		});
		const result = await resolveModelAvailability(codexAgent(["gpt-6-astra"]));
		expect(result).toEqual({ status: "unknown" });
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("treats a Cursor xhigh preset as available when the base family is listed", async () => {
		// The account lists gpt-5.6-sol-high (not -xhigh); base-family match keeps the
		// dev3 preset gpt-5.6-sol-xhigh available, and flags an absent family.
		mockSpawn.mockReturnValue(fakeProc("Available models\n\ngpt-5.6-sol-high - GPT-5.6 Sol\n"));
		const agent: CodingAgent = {
			id: "builtin-cursor",
			name: "Cursor",
			baseCommand: "agent",
			configurations: [
				{ id: "a", name: "sol", model: "gpt-5.6-sol-xhigh" },
				{ id: "b", name: "grok", model: "cursor-grok-4.6-high-fast" },
			],
		};
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "resolved", unavailable: ["cursor-grok-4.6-high-fast"] });
	});

	it("returns unknown for an empty catalog rather than flagging everything", async () => {
		mockSpawn.mockReturnValue(fakeProc(JSON.stringify({ models: [] })));
		const result = await resolveModelAvailability(codexAgent(["gpt-6-sol"]));
		expect(result).toEqual({ status: "unknown" });
	});

	it("returns unknown on a non-zero exit", async () => {
		mockSpawn.mockReturnValue(fakeProc("", 1));
		const result = await resolveModelAvailability(codexAgent(["gpt-6-sol"]));
		expect(result).toEqual({ status: "unknown" });
	});

	it("returns unknown for an agent whose CLI has no model-list command", async () => {
		const agent: CodingAgent = {
			id: "builtin-gemini",
			name: "Gemini",
			baseCommand: "gemini",
			configurations: [{ id: "g", name: "pro", model: "gemini-3.1-pro-preview" }],
		};
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "unknown" });
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("exempts routed presets (model roles) from the filter", async () => {
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent: CodingAgent = {
			id: "builtin-codex",
			name: "Codex",
			baseCommand: "codex",
			configurations: [
				{ id: "routed", name: "routed", model: "some-routed-model", modelRoles: { main: "x" } },
				{ id: "dead", name: "dead", model: "gpt-6-sol" },
			],
		};
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
	});

	it("probes each account separately, against its own CODEX_HOME catalog", async () => {
		// Enterprise home lacks gpt-6-sol; personal home has it. The same preset must
		// be flagged under one account and allowed under the other.
		mockCodexSessionEnv.mockImplementation(async (id: string | null | undefined) =>
			id === "enterprise" ? { CODEX_HOME: "/homes/ent" } : { CODEX_HOME: "/homes/personal" },
		);
		const ENT = JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list", supported_in_api: true }] });
		const PERSONAL = JSON.stringify({
			models: [
				{ slug: "gpt-6-astra", visibility: "list", supported_in_api: true },
				{ slug: "gpt-6-sol", visibility: "list", supported_in_api: true },
			],
		});
		mockSpawn.mockImplementation((_cmd: string[], opts: { env?: Record<string, string> }) =>
			fakeProc(opts?.env?.CODEX_HOME === "/homes/ent" ? ENT : PERSONAL),
		);
		const agent = codexAgent(["gpt-6-astra", "gpt-6-sol"]);

		const ent = await resolveModelAvailability(agent, { accountId: "enterprise" });
		const personal = await resolveModelAvailability(agent, { accountId: "personal" });

		expect(ent).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
		expect(personal).toEqual({ status: "resolved", unavailable: [] });
		// Two distinct accounts → two real probes (cache keyed on CODEX_HOME).
		expect(mockSpawn).toHaveBeenCalledTimes(2);
		expect(mockSpawn.mock.calls[0][1].env).toEqual({ CODEX_HOME: "/homes/ent" });
		expect(mockSpawn.mock.calls[1][1].env).toEqual({ CODEX_HOME: "/homes/personal" });
	});

	it("honors an explicit CODEX_HOME on the default preset over the account", async () => {
		mockCodexSessionEnv.mockResolvedValue({ CODEX_HOME: "/homes/account" });
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent: CodingAgent = {
			id: "builtin-codex",
			name: "Codex",
			baseCommand: "codex",
			defaultConfigId: "pinned",
			configurations: [{ id: "pinned", name: "pinned", model: "gpt-6-astra", envVars: { CODEX_HOME: "/homes/pinned" } }],
		};
		await resolveModelAvailability(agent, { accountId: "account" });
		expect(mockSpawn.mock.calls[0][1].env).toEqual({ CODEX_HOME: "/homes/pinned" });
		expect(mockCodexSessionEnv).not.toHaveBeenCalled();
	});

	it("returns unknown without probing when the Codex home is logged out", async () => {
		// Logged out: no auth.json and no API key. A logged-out `codex debug models`
		// still prints its bundled catalog, which must not be trusted as the account.
		mockCodexHomeSignedIn.mockReturnValue(false);
		mockCodexSessionEnv.mockResolvedValue({ CODEX_HOME: "/homes/ent" });
		const result = await resolveModelAvailability(codexAgent(["gpt-6-sol"]), { accountId: "ent" });
		expect(result).toEqual({ status: "unknown" });
		expect(mockCodexHomeSignedIn).toHaveBeenCalledWith("/homes/ent");
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("treats an API key on the default preset as signed in", async () => {
		mockCodexHomeSignedIn.mockReturnValue(false);
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent: CodingAgent = {
			id: "builtin-codex",
			name: "Codex",
			baseCommand: "codex",
			configurations: [{ id: "k", name: "k", model: "gpt-6-sol", envVars: { OPENAI_API_KEY: "sk-x" } }],
		};
		expect(await resolveModelAvailability(agent)).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
	});

	it("probes the user's custom binary path from settings", async () => {
		mockApplyBinaryPathOverride.mockImplementation((agent: CodingAgent) => ({
			...agent,
			baseCommand: "/custom/bin/codex",
			agentFamily: "codex",
		}));
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const result = await resolveModelAvailability(codexAgent(["gpt-6-sol"]));
		expect(mockSpawn.mock.calls[0][0]).toEqual(["/custom/bin/codex", "debug", "models"]);
		expect(result).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
	});

	it("does not judge a preset that launches a different binary than the probed one", async () => {
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent: CodingAgent = {
			id: "builtin-codex",
			name: "Codex",
			baseCommand: "codex",
			defaultConfigId: "plain",
			configurations: [
				{ id: "plain", name: "plain", model: "gpt-6-sol" },
				{ id: "other", name: "other", model: "gpt-7-preview", baseCommandOverride: "/opt/beta/codex" },
			],
		};
		const result = await resolveModelAvailability(agent);
		expect(mockSpawn.mock.calls[0][0]).toEqual(["codex", "debug", "models"]);
		expect(result).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
	});

	it("probes the launch binary: the default preset's baseCommandOverride", async () => {
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent: CodingAgent = {
			id: "builtin-codex",
			name: "Codex",
			baseCommand: "codex",
			defaultConfigId: "custom",
			configurations: [{ id: "custom", name: "custom", model: "gpt-6-astra", baseCommandOverride: "/opt/my/codex" }],
		};
		await resolveModelAvailability(agent);
		expect(mockApplyBinaryPathOverride).toHaveBeenCalledWith(agent, {}, {});
		expect(mockSpawn.mock.calls[0][0]).toEqual(["/opt/my/codex", "debug", "models"]);
	});
});
