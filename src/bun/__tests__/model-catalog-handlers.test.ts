import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogView } from "../../shared/types";

const h = vi.hoisted(() => ({
	save: vi.fn(),
	load: vi.fn(() => ({ providers: [], models: [] })),
	loadKeys: vi.fn(() => ({}) as Record<string, string>),
	setKey: vi.fn(),
	forget: vi.fn(),
	status: vi.fn(() => ({ running: false, starting: false, binaryAvailable: true, version: "v0", providerCount: 0, modelCount: 0 })),
	restart: vi.fn(),
}));

vi.mock("../model-catalog-store", () => ({
	saveModelCatalog: h.save,
	loadModelCatalog: h.load,
	loadProviderKeys: h.loadKeys,
	setProviderKey: h.setKey,
	forgetProviderKeys: h.forget,
}));
vi.mock("../model-sidecar", () => ({
	getModelSidecarStatus: h.status,
	ensureModelSidecar: vi.fn(),
	listSidecarModels: vi.fn(),
	restartModelSidecar: h.restart,
	stopModelSidecar: vi.fn(),
}));

import { modelCatalogSave } from "../rpc-handlers/model-catalog";

const OPENROUTER = { id: "p-1", kind: "openrouter" as const, label: "OpenRouter", hasKey: true };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("saving the catalog", () => {
	it("stores a catalog with one provider per kind", async () => {
		const view: ModelCatalogView = { providers: [OPENROUTER], models: [] };
		await modelCatalogSave({ catalog: view });
		expect(h.save).toHaveBeenCalledOnce();
	});

	// Both providers resolve to the same key in the generated config, so the second
	// silently overwrites the first and every model under it stops routing. The
	// settings table blocks it; the connect flow appends without ever seeing it.
	it("refuses a second provider that would serve the same wire prefix", async () => {
		const view: ModelCatalogView = {
			providers: [OPENROUTER, { ...OPENROUTER, id: "p-2", hasKey: false }],
			models: [{ id: "m-1", providerId: "p-1", name: "fast", modelId: "deepseek/flash" }],
		};
		await expect(modelCatalogSave({ catalog: view })).rejects.toThrow(/already serves "openrouter"/);
		// Nothing is written, so the working catalog survives the rejected save.
		expect(h.save).not.toHaveBeenCalled();
		expect(h.setKey).not.toHaveBeenCalled();
	});

	it("refuses two custom endpoints whose labels collapse to one key", async () => {
		const custom = { id: "c-1", kind: "custom" as const, label: "My Box", baseUrl: "https://a.example", hasKey: false };
		const view: ModelCatalogView = {
			providers: [custom, { ...custom, id: "c-2", label: "my-box", baseUrl: "https://b.example" }],
			models: [],
		};
		await expect(modelCatalogSave({ catalog: view })).rejects.toThrow(/already serves "custom-my-box"/);
	});
});
