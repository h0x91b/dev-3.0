import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSidecarConfig, catalogModelWireName, type ModelCatalog } from "../../shared/model-catalog";
import type { ModelCatalogView } from "../../shared/types";

const h = vi.hoisted(() => ({
	save: vi.fn(),
	load: vi.fn((): ModelCatalog => ({ providers: [], models: [] })),
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

import { modelCatalogHandlers, modelCatalogSave } from "../rpc-handlers/model-catalog";

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

describe("renaming a custom provider", () => {
	const model = { id: "m-1", providerId: "c-1", name: "kimi", modelId: "kimi-k3" };
	const custom = { id: "c-1", kind: "custom" as const, label: "Custom endpoint", baseUrl: "https://a.example", hasKey: false };

	it("keeps the wire name an agent already holds", async () => {
		await modelCatalogSave({ catalog: { providers: [custom], models: [model] } });
		const first = h.save.mock.calls[0][0] as ModelCatalog;
		const heldByAgent = catalogModelWireName(first, "m-1");
		expect(heldByAgent).toBe("custom-custom-endpoint/kimi");

		h.load.mockReturnValueOnce(first);
		await modelCatalogSave({ catalog: { providers: [{ ...custom, label: "Kimi code" }], models: [model] } });
		const renamed = h.save.mock.calls[1][0] as ModelCatalog;
		expect(renamed.providers[0].label).toBe("Kimi code");
		expect(catalogModelWireName(renamed, "m-1")).toBe(heldByAgent);
		expect(Object.keys(buildSidecarConfig(renamed).providers)).toEqual(["custom-custom-endpoint"]);
	});

	it("keeps the old-label key of a provider saved before wire keys existed", async () => {
		h.load.mockReturnValueOnce({ providers: [{ id: "c-1", kind: "custom", label: "Custom endpoint", baseUrl: "https://a.example" }], models: [model] });
		await modelCatalogSave({ catalog: { providers: [{ ...custom, label: "Kimi code" }], models: [model] } });
		const renamed = h.save.mock.calls[0][0] as ModelCatalog;
		expect(catalogModelWireName(renamed, "m-1")).toBe("custom-custom-endpoint/kimi");
	});

	it("does not trust a wire key sent by the renderer", async () => {
		await modelCatalogSave({ catalog: { providers: [{ ...custom, wireKey: "custom-evil" }], models: [] } });
		expect((h.save.mock.calls[0][0] as ModelCatalog).providers[0].wireKey).toBe("custom-custom-endpoint");
	});
});

describe("usage tracking on a provider", () => {
	const custom = {
		id: "c-1",
		kind: "custom" as const,
		label: "Kimi",
		baseUrl: "https://a.example/coding/",
		usageSource: "kimi-code" as const,
		hasKey: false,
	};

	it("survives a save and a read back", async () => {
		const view: ModelCatalogView = { providers: [custom], models: [] };
		await modelCatalogSave({ catalog: view });
		const stored = h.save.mock.calls[0][0] as ModelCatalog;
		expect(stored.providers[0].usageSource).toBe("kimi-code");
		h.load.mockReturnValueOnce(stored);
		expect(modelCatalogHandlers.modelCatalogGet().providers[0].usageSource).toBe("kimi-code");
	});
});

describe("revealing a stored key", () => {
	it("hands back the key of a provider the catalog holds", () => {
		h.load.mockReturnValue({ providers: [{ id: "p-1", kind: "openrouter", label: "OpenRouter" }], models: [] });
		h.loadKeys.mockReturnValue({ "p-1": "sk-or-live" });
		expect(modelCatalogHandlers.modelCatalogRevealKey({ providerId: "p-1" })).toEqual({ key: "sk-or-live" });
	});

	it("refuses a provider that has no key, instead of answering with an empty string", () => {
		h.load.mockReturnValue({ providers: [{ id: "p-1", kind: "openrouter", label: "OpenRouter" }], models: [] });
		h.loadKeys.mockReturnValue({});
		expect(() => modelCatalogHandlers.modelCatalogRevealKey({ providerId: "p-1" })).toThrow(/no stored key/);
	});

	// The keys file also holds the sidecar's at-rest encryption key under a
	// reserved slot. Naming a slot that is not a provider must reveal nothing.
	it("never reveals a slot that is not a provider in the catalog", () => {
		h.load.mockReturnValue({ providers: [], models: [] });
		h.loadKeys.mockReturnValue({ "dev3:sidecar-encryption-key": "deadbeef" });
		expect(() =>
			modelCatalogHandlers.modelCatalogRevealKey({ providerId: "dev3:sidecar-encryption-key" }),
		).toThrow(/no stored key/);
	});
});
