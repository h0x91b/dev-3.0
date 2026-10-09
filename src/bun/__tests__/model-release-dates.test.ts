import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../../shared/types";
import { AGENT_CHOSEN_MODEL_SLUGS, MODEL_RELEASE_DATES, modelReleaseDate } from "../../shared/model-release-dates";

describe("MODEL_RELEASE_DATES", () => {
	it("dates every model a built-in preset pins, so a new one cannot sink to the bottom", () => {
		const undated = new Set<string>();
		for (const agent of DEFAULT_AGENTS) {
			for (const config of agent.configurations) {
				if (!config.model || AGENT_CHOSEN_MODEL_SLUGS.has(config.model)) continue;
				if (!modelReleaseDate(config.model)) undated.add(`${agent.id}: ${config.model}`);
			}
		}
		expect([...undated]).toEqual([]);
	});

	it("holds real calendar days only", () => {
		for (const [model, date] of Object.entries(MODEL_RELEASE_DATES)) {
			expect(date, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), model).toBe(date);
		}
	});

	it("carries no entry for a model no preset ships", () => {
		const shipped = new Set(DEFAULT_AGENTS.flatMap((a) => a.configurations.map((c) => c.model)));
		expect(Object.keys(MODEL_RELEASE_DATES).filter((model) => !shipped.has(model))).toEqual([]);
	});

	it("dates Haiku 5.5 to the day it shipped", () => {
		expect(modelReleaseDate("claude-haiku-5-5")).toBe("2026-10-08");
	});

	it("knows nothing about unknown or missing slugs", () => {
		expect(modelReleaseDate("some-local-model")).toBeUndefined();
		expect(modelReleaseDate(undefined)).toBeUndefined();
	});
});
