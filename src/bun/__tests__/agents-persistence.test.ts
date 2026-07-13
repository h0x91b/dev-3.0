import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgent } from "../../shared/types";
import { DEFAULT_AGENTS } from "../../shared/types";

const { TEST_HOME, AGENTS_FILE } = vi.hoisted(() => {
	const home = `/tmp/dev3-agents-persistence-${process.pid}`;
	return { TEST_HOME: home, AGENTS_FILE: `${home}/agents.json` };
});

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ agentsLayoutRevision: 10 })),
	saveSettings: vi.fn(async () => undefined),
}));

import { getAllAgents } from "../agents";

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
	(globalThis as any).Bun.write = vi.fn(async (path: string, data: string) => {
		writeFileSync(path, data);
		return data.length;
	});
});

afterEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("getAllAgents persistence", () => {
	it("persists deprecated preset cleanup even when the layout revision is current", async () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex")!;
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [
				...codex.configurations,
				{ id: "codex-5.3-heavy", name: "GPT-5.3 Codex High", model: "gpt-5.3-codex" },
			],
		}];
		writeFileSync(AGENTS_FILE, JSON.stringify(stored));

		await getAllAgents();

		const persisted = JSON.parse(readFileSync(AGENTS_FILE, "utf8")) as CodingAgent[];
		const persistedCodex = persisted.find((agent) => agent.id === "builtin-codex")!;
		expect(persistedCodex.configurations.some((config) => config.id === "codex-5.3-heavy")).toBe(false);
	});

	it("persists upgraded built-in presentation labels for cross-version readers", async () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex")!;
		const currentDefault = codex.configurations.find((config) => config.id === "codex-default")!;
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [{
				...currentDefault,
				groupLabel: undefined,
				version: (currentDefault.version ?? 1) - 1,
			}],
		}];
		writeFileSync(AGENTS_FILE, JSON.stringify(stored));

		await getAllAgents();

		const persisted = JSON.parse(readFileSync(AGENTS_FILE, "utf8")) as CodingAgent[];
		const persistedDefault = persisted
			.find((agent) => agent.id === "builtin-codex")!
			.configurations.find((config) => config.id === "codex-default")!;
		expect(persistedDefault.groupLabel).toBe("GPT-5.6 Luna");
	});
});
