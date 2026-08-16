import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../../shared/model-catalog";

const spawnMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock("../spawn", () => ({ spawn: spawnMock }));
vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../model-sidecar", () => ({ RUNTIME_DIR: "/tmp/dev3-probe-runtime" }));

const { writeCodexModelCatalog } = await import("../codex-model-catalog");

function fakeProc(stdout: string, exitCode = 0) {
	const encoder = new TextEncoder();
	return {
		exited: Promise.resolve(exitCode),
		kill: vi.fn(),
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stdout));
				controller.close();
			},
		}),
	};
}

const DUMP = JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list", priority: 7, base_instructions: "plain" }] });

const catalog: ModelCatalog = {
	providers: [{ id: "p-or", kind: "openrouter", label: "OpenRouter" }],
	models: [{ id: "m1", providerId: "p-or", name: "fast-gremlin", modelId: "deepseek/deepseek-flash" }],
};

describe("writeCodexModelCatalog", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		writeFileSyncMock.mockReset();
	});

	it("asks Codex itself for the metadata it will clone", async () => {
		spawnMock.mockReturnValue(fakeProc(DUMP));
		await writeCodexModelCatalog("codex", catalog);
		expect(spawnMock.mock.calls[0]?.[0]).toEqual(["codex", "debug", "models"]);
	});

	it("writes the generated document and returns its path", async () => {
		spawnMock.mockReturnValue(fakeProc(DUMP));
		const path = await writeCodexModelCatalog("codex", catalog);
		expect(path).toBe("/tmp/dev3-probe-runtime/codex-models.json");
		const written = JSON.parse(String(writeFileSyncMock.mock.calls[0]?.[1]));
		expect(written.models.map((m: { slug: string }) => m.slug)).toEqual(["openrouter/fast-gremlin", "gpt-5.5"]);
	});

	// Every failure below must launch the agent unchanged: worse metadata beats
	// no session at all.
	it("gives up quietly when the dump is unusable", async () => {
		for (const proc of [fakeProc(DUMP, 1), fakeProc("not json"), fakeProc('{"models":[]}')]) {
			spawnMock.mockReturnValue(proc);
			expect(await writeCodexModelCatalog("codex", catalog)).toBeUndefined();
		}
		expect(writeFileSyncMock).not.toHaveBeenCalled();
	});

	it("gives up quietly when the file cannot be written", async () => {
		spawnMock.mockReturnValue(fakeProc(DUMP));
		writeFileSyncMock.mockImplementation(() => {
			throw new Error("EROFS");
		});
		expect(await writeCodexModelCatalog("codex", catalog)).toBeUndefined();
	});
});
