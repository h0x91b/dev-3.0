import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths", () => ({
	get DEV3_HOME() {
		return h.home;
	},
}));

async function freshModule() {
	vi.resetModules();
	return await import("../model-catalog-store");
}

beforeEach(() => {
	h.home = mkdtempSync(join(tmpdir(), "dev3-catalog-store-"));
});

afterEach(() => {
	rmSync(h.home, { recursive: true, force: true });
});

describe("provider keys", () => {
	it("round-trips a key and keeps the file owner-only", async () => {
		const { setProviderKey, loadProviderKeys } = await freshModule();
		setProviderKey("p-or", "sk-live");

		expect(loadProviderKeys()["p-or"]).toBe("sk-live");
		expect(statSync(join(h.home, "model-catalog-keys.json")).mode & 0o777).toBe(0o600);
	});

	// A torn keys file is not just lost state: the parse error is swallowed, every
	// key disappears, and a NEW sidecar encryption key is generated — after which
	// the proxy dies decrypting what its own store already holds.
	it("never leaves a partial file behind: the write lands through a rename", async () => {
		const { setProviderKey } = await freshModule();
		setProviderKey("p-or", "sk-first");
		setProviderKey("p-oai", "sk-second");

		// A temp file surviving the write is the tell that the rename never happened.
		expect(readdirSync(h.home).filter((f) => f.includes(".tmp-"))).toEqual([]);
		const raw = readFileSync(join(h.home, "model-catalog-keys.json"), "utf-8");
		expect(JSON.parse(raw)).toEqual({ "p-or": "sk-first", "p-oai": "sk-second" });
	});

	it("keeps the encryption key across loads instead of rotating it", async () => {
		const { loadOrCreateEncryptionKey } = await freshModule();
		const first = loadOrCreateEncryptionKey();

		expect(loadOrCreateEncryptionKey()).toBe(first);
		expect(first).toHaveLength(64);
	});

	it("drops the key of a provider the user removed, but not the encryption key", async () => {
		const { setProviderKey, loadOrCreateEncryptionKey, forgetProviderKeys, loadProviderKeys } = await freshModule();
		const encryption = loadOrCreateEncryptionKey();
		setProviderKey("p-or", "sk-live");
		setProviderKey("p-oai", "sk-other");

		forgetProviderKeys([{ id: "p-or", kind: "openrouter", label: "OpenRouter" }]);

		const keys = loadProviderKeys();
		expect(keys["p-or"]).toBe("sk-live");
		expect(keys["p-oai"]).toBeUndefined();
		expect(keys["dev3:sidecar-encryption-key"]).toBe(encryption);
	});
});

describe("catalog", () => {
	it("round-trips providers and models", async () => {
		const { saveModelCatalog, loadModelCatalog } = await freshModule();
		saveModelCatalog({
			providers: [{ id: "p-or", kind: "openrouter", label: "OpenRouter" }],
			models: [{ id: "m", providerId: "p-or", name: "fast", modelId: "deepseek/flash" }],
		});

		expect(loadModelCatalog().models[0]?.name).toBe("fast");
	});

	it("reads an empty catalog rather than throwing when the file is corrupt", async () => {
		const { saveModelCatalog, loadModelCatalog } = await freshModule();
		saveModelCatalog({ providers: [], models: [] });
		// Simulate the torn write the atomic path exists to prevent.
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(h.home, "model-catalog.json"), '{"providers": [');

		expect(loadModelCatalog()).toEqual({ providers: [], models: [] });
	});
});
