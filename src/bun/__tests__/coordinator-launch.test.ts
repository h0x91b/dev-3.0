import { describe, it, expect } from "vitest";
import { DEFAULT_AGENTS } from "../../shared/types";
import { coordinatorLaunchDefault, DEFAULT_COORDINATOR_CONFIG_ID } from "../../shared/coordinator-launch";

describe("coordinatorLaunchDefault", () => {
	it("ships Claude on Auto (Fable 5.1, Medium) — a preset that really exists", () => {
		const choice = coordinatorLaunchDefault(DEFAULT_AGENTS, {});
		expect(choice).toEqual({ agentId: "builtin-claude", configId: DEFAULT_COORDINATOR_CONFIG_ID });
		const config = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")?.configurations.find((c) => c.id === choice?.configId);
		expect(config).toMatchObject({ model: expect.stringContaining("fable-5-1"), effort: "medium", permissionMode: "auto" });
	});

	it("honours the user's pick", () => {
		expect(coordinatorLaunchDefault(DEFAULT_AGENTS, { coordinatorAgentId: "builtin-codex", coordinatorConfigId: "codex-default" }))
			.toEqual({ agentId: "builtin-codex", configId: "codex-default" });
	});

	it("falls back to the agent's own default when the preset belongs elsewhere", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex");
		expect(coordinatorLaunchDefault(DEFAULT_AGENTS, { coordinatorAgentId: "builtin-codex" }))
			.toEqual({ agentId: "builtin-codex", configId: codex?.defaultConfigId });
	});

	it("returns null when the agent is gone, so callers keep the global default", () => {
		expect(coordinatorLaunchDefault(DEFAULT_AGENTS, { coordinatorAgentId: "removed-agent" })).toBeNull();
	});
});
