import { describe, it, expect } from "vitest";
import {
	CODEX_MODEL_MIN_CLI_VERSION,
	evaluateCodexModelSupport,
	isCliVersionAtLeast,
	parseCliVersion,
} from "../../shared/agent-model-cli-requirements";
import { DEFAULT_AGENTS } from "../../shared/types";

describe("parseCliVersion", () => {
	it("reads the version out of a --version line", () => {
		expect(parseCliVersion("codex-cli 0.153.4")).toEqual({ major: 0, minor: 153, patch: 4 });
		expect(parseCliVersion("OpenAI Codex (v0.131.2)")).toEqual({ major: 0, minor: 131, patch: 2 });
	});

	it("returns null when there is no version to read", () => {
		expect(parseCliVersion("")).toBeNull();
		expect(parseCliVersion("command not found")).toBeNull();
	});
});

describe("isCliVersionAtLeast", () => {
	const threshold = { major: 0, minor: 153, patch: 1 };

	it("compares minor before patch", () => {
		expect(isCliVersionAtLeast({ major: 0, minor: 144, patch: 9 }, threshold)).toBe(false);
		expect(isCliVersionAtLeast({ major: 0, minor: 153, patch: 0 }, threshold)).toBe(false);
		expect(isCliVersionAtLeast({ major: 0, minor: 153, patch: 1 }, threshold)).toBe(true);
		expect(isCliVersionAtLeast({ major: 1, minor: 0, patch: 0 }, threshold)).toBe(true);
	});

	it("treats an unknown version as not sufficient", () => {
		expect(isCliVersionAtLeast(null, threshold)).toBe(false);
	});
});

describe("evaluateCodexModelSupport", () => {
	it("flags the reported case: 0.144.4 cannot run gpt-6-astra (issue #1667)", () => {
		expect(evaluateCodexModelSupport("gpt-6-astra", "codex-cli 0.144.4")).toEqual({
			status: "too-old",
			model: "gpt-6-astra",
			installed: "0.144.4",
			required: "0.153.1",
		});
	});

	it("accepts the version the reporter upgraded to", () => {
		expect(evaluateCodexModelSupport("gpt-6-astra", "codex-cli 0.153.4").status).toBe("ok");
	});

	it("accepts the first release that ships the model", () => {
		expect(evaluateCodexModelSupport("gpt-6-astra", "codex-cli 0.153.1").status).toBe("ok");
		expect(evaluateCodexModelSupport("gpt-6-astra", "codex-cli 0.153.0").status).toBe("too-old");
	});

	it("says nothing about a model with no known floor", () => {
		expect(evaluateCodexModelSupport("gpt-5.6-sol", "codex-cli 0.100.0").status).toBe("unknown");
	});

	// An unreadable probe must never turn into a warning the user cannot act on.
	it("stays silent when the version or the model is unknown", () => {
		expect(evaluateCodexModelSupport("gpt-6-astra", null).status).toBe("unknown");
		expect(evaluateCodexModelSupport("gpt-6-astra", "codex").status).toBe("unknown");
		expect(evaluateCodexModelSupport(undefined, "codex-cli 0.144.4").status).toBe("unknown");
		expect(evaluateCodexModelSupport("some-future-model", "codex-cli 0.144.4").status).toBe("unknown");
	});
});

describe("every builtin Codex model states its CLI requirement", () => {
	it("has a map entry for each model a builtin preset pins", () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex");
		expect(codex).toBeDefined();
		const models = [...new Set((codex?.configurations ?? []).map((c) => c.model).filter((m): m is string => !!m))];
		expect(models.length).toBeGreaterThan(0);
		const unlisted = models.filter((model) => !(model in CODEX_MODEL_MIN_CLI_VERSION));
		// Adding a preset for a freshly released model must state its floor —
		// `null` is a valid answer, silence is not. That silence is exactly what
		// made gpt-6-astra the opaque default failure in issue #1667.
		expect(unlisted).toEqual([]);
	});
});
