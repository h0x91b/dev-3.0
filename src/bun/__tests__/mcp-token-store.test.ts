import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	McpConfigCache,
	generateMcpToken,
	mcpConfigPath,
	mcpConfigPathProblem,
	readMcpConfig,
	updateMcpConfig,
	type McpTokenRecord,
} from "../mcp/token-store";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(`${tmpdir()}/dev3-mcp-store-`);
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<McpTokenRecord> = {}): { token: string; record: McpTokenRecord } {
	const { token, id, sha256 } = generateMcpToken();
	return {
		token,
		record: {
			id, sha256, sender: "bot", scopes: ["read"], projects: ["*"], autoApprove: false, label: null,
			createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, ...overrides,
		},
	};
}

describe("store location", () => {
	it("lives under XDG_CONFIG_HOME (or ~/.config), and %APPDATA% on Windows — never under ~/.dev3.0", () => {
		expect(mcpConfigPath({ HOME: "/u", XDG_CONFIG_HOME: "/x" }, "linux")).toBe("/x/dev3/mcp.json");
		expect(mcpConfigPath({ HOME: "/u" }, "darwin")).toBe("/u/.config/dev3/mcp.json");
		expect(mcpConfigPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32")).toBe("C:/Users/u/AppData/Roaming/dev3/mcp.json");
		expect(mcpConfigPathProblem("/u/.config/dev3/mcp.json", { HOME: "/u" })).toBeNull();
	});

	it("is refused inside the dev3 data root, which task sandboxes can write", async () => {
		const root = tempDir();
		expect(mcpConfigPathProblem(`${root}/.dev3.0/x/mcp.json`, { HOME: root })).toMatch(/inside the dev3 data root/);
		expect(mcpConfigPathProblem(`${root}/data/mcp.json`, { DEV3_HOME: `${root}/data` })).toMatch(/inside the dev3 data root/);
		vi.stubEnv("DEV3_HOME", root);
		try {
			await expect(updateMcpConfig(() => null, `${root}/mcp.json`)).rejects.toThrow(/inside the dev3 data root/);
			const cache = new McpConfigCache(`${root}/mcp.json`);
			expect(cache.current().error).toMatch(/inside the dev3 data root/);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("writes", () => {
	it("stores the hash only, 0600 in a 0700 directory", async () => {
		const path = `${tempDir()}/dev3/mcp.json`;
		const { token, record: r } = record();
		await updateMcpConfig((c) => c.tokens.push(r), path);
		const text = readFileSync(path, "utf8");
		expect(text).not.toContain(token);
		expect(text).not.toContain("dev3mcp_");
		expect(text).toContain(r.sha256);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(`${path.slice(0, -"/mcp.json".length)}`).mode & 0o777).toBe(0o700);
		}
	});

	it("never loses a concurrent update", async () => {
		const path = `${tempDir()}/dev3/mcp.json`;
		await Promise.all(Array.from({ length: 5 }, () => updateMcpConfig((c) => c.tokens.push(record().record), path)));
		const read = readMcpConfig(path);
		expect(read.ok && read.config.tokens.length).toBe(5);
	});

	it("refuses to rewrite a file it cannot parse", async () => {
		const path = `${tempDir()}/mcp.json`;
		writeFileSync(path, "{broken");
		await expect(updateMcpConfig(() => null, path)).rejects.toThrow(/Refusing to rewrite/);
		expect(readFileSync(path, "utf8")).toBe("{broken");
	});
});

describe("the app's cache", () => {
	it("accepts a live token and refuses revoked, expired and unknown ones", async () => {
		const path = `${tempDir()}/mcp.json`;
		const live = record();
		const revoked = record({ revokedAt: new Date().toISOString() });
		const expired = record({ expiresAt: new Date(Date.now() - 1000).toISOString() });
		await updateMcpConfig((c) => c.tokens.push(live.record, revoked.record, expired.record), path);
		const cache = new McpConfigCache(path);
		expect(cache.lookup(live.token)?.id).toBe(live.record.id);
		expect(cache.lookup(revoked.token)).toBeNull();
		expect(cache.lookup(expired.token)).toBeNull();
		expect(cache.lookup("dev3mcp_nope")).toBeNull();
		expect(cache.lookup(live.record.sha256)).toBeNull();
	});

	it("fails closed when the file breaks or comes from a newer version, and recovers when fixed", async () => {
		const path = `${tempDir()}/mcp.json`;
		const live = record();
		await updateMcpConfig((c) => {
			c.enabled = true;
			c.tokens.push(live.record);
		}, path);
		const cache = new McpConfigCache(path);
		expect(cache.lookup(live.token)).not.toBeNull();
		const good = readFileSync(path, "utf8");
		writeFileSync(path, "{broken json");
		expect(cache.lookup(live.token)).toBeNull();
		expect(cache.current().config.enabled).toBe(true);
		writeFileSync(path, JSON.stringify({ ...JSON.parse(good), v: 2 }));
		expect(cache.lookup(live.token)).toBeNull();
		writeFileSync(path, good);
		expect(cache.lookup(live.token)).not.toBeNull();
	});
});
