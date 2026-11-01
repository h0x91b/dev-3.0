import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const root = vi.hoisted(() => {
	const fs = require("node:fs");
	const dir = fs.mkdtempSync(`${require("node:os").tmpdir()}/dev3-mcp-cli-`) as string;
	fs.mkdirSync(`${dir}/data`, { recursive: true });
	process.env.DEV3_HOME = `${dir}/data`;
	process.env.XDG_CONFIG_HOME = `${dir}/config`;
	return dir;
});

import { handleMcp } from "../commands/mcp";
import { CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN } from "../../shared/cli-exit-codes";

const STORE = `${root}/config/dev3/mcp.json`;
let stdout = "";
let stderr = "";

beforeEach(() => {
	stdout = "";
	stderr = "";
	rmSync(`${root}/config`, { recursive: true, force: true });
	writeFileSync(`${root}/data/external-senders.json`, JSON.stringify({ senders: { "openclaw:home:main": { label: "Main" } } }));
	vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((stdout += String(c)), true));
	vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((stderr += String(c)), true));
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const issueArgs = (flags: Record<string, string>) => ({ positional: ["issue"], flags: { sender: "openclaw:home:main", projects: "*", ...flags } });

describe("dev3 mcp token", () => {
	it("issue prints the token once and stores only its hash, read scope by default", async () => {
		await handleMcp("token", issueArgs({ json: "true" }), null, null);
		const out = JSON.parse(stdout);
		expect(out.token).toMatch(/^dev3mcp_[A-Za-z0-9_-]{43}$/);
		expect(out.scopes).toEqual(["read"]);
		const stored = readFileSync(STORE, "utf8");
		expect(stored).not.toContain(out.token);
		expect(JSON.parse(stored).tokens[0]).toMatchObject({ id: out.id, sender: "openclaw:home:main", projects: ["*"], revokedAt: null });
		expect(Date.parse(out.expiresAt) - Date.now()).toBeGreaterThan(89 * 86_400_000);
	});

	it("warns when a scope lets the holder drive agents", async () => {
		await handleMcp("token", issueArgs({ scope: "read,send" }), null, null);
		expect(stderr).toMatch(/not to a model-driven client/);
	});

	it("refuses an unregistered sender with exit 39 and writes nothing", async () => {
		await expect(handleMcp("token", issueArgs({ sender: "nobody" }), null, null)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN}`);
		expect(() => readFileSync(STORE)).toThrow();
	});

	it("requires --projects and refuses unknown scopes", async () => {
		await expect(handleMcp("token", { positional: ["issue"], flags: { sender: "openclaw:home:main" } }, null, null)).rejects.toThrow("EXIT_3");
		await expect(handleMcp("token", issueArgs({ scope: "read,root" }), null, null)).rejects.toThrow("EXIT_3");
	});

	it("is refused inside a task", async () => {
		const ctx = { projectId: "p", taskId: "t", socketPath: "/s" };
		await expect(handleMcp("token", issueArgs({}), ctx, null)).rejects.toThrow("EXIT_3");
		vi.stubEnv("DEV3_TASK_ID", "abc");
		await expect(handleMcp("enable", { positional: [], flags: {} }, null, null)).rejects.toThrow("EXIT_3");
	});

	it("list never shows a hash; revoke stamps revokedAt", async () => {
		await handleMcp("token", issueArgs({ json: "true" }), null, null);
		const { id } = JSON.parse(stdout);
		stdout = "";
		await handleMcp("token", { positional: ["revoke", id], flags: {} }, null, null);
		stdout = "";
		await handleMcp("token", { positional: ["list"], flags: { json: "true" } }, null, null);
		const listed = JSON.parse(stdout).tokens[0];
		expect(listed.sha256).toBeUndefined();
		expect(listed.revokedAt).not.toBeNull();
		expect(listed.live).toBe(false);
	});
});

describe("dev3 mcp enable|disable", () => {
	it("flips the switch and the port in the store", async () => {
		await handleMcp("enable", { positional: [], flags: { port: "7400" } }, null, null);
		expect(JSON.parse(readFileSync(STORE, "utf8"))).toMatchObject({ enabled: true, listen: { port: 7400 } });
		await handleMcp("disable", { positional: [], flags: {} }, null, null);
		expect(JSON.parse(readFileSync(STORE, "utf8")).enabled).toBe(false);
	});
});
