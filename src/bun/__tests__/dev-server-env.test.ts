import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BLOCKED_DEV_SERVER_ENV_KEYS,
	isBlockedDevServerEnvKey,
	parseDevServerEnvPair,
	sanitizeDevServerEnv,
} from "../../shared/dev-server-env";

describe("parseDevServerEnvPair", () => {
	it("splits on the first =, so a value may contain more of them", () => {
		expect(parseDevServerEnvPair("DEV3_QA_SCOPE=seeded")).toEqual({ key: "DEV3_QA_SCOPE", value: "seeded" });
		expect(parseDevServerEnvPair("DSN=postgres://u:p@h/db?a=1")).toEqual({
			key: "DSN",
			value: "postgres://u:p@h/db?a=1",
		});
	});

	// `--env DEBUG=` is how a shell unsets-by-empty; refusing it would be surprising.
	it("accepts an empty value", () => {
		expect(parseDevServerEnvPair("DEBUG=")).toEqual({ key: "DEBUG", value: "" });
	});

	it("rejects an argument that is not KEY=VALUE", () => {
		expect(parseDevServerEnvPair("DEV3_QA_SCOPE")).toHaveProperty("error");
		expect(parseDevServerEnvPair("=seeded")).toHaveProperty("error");
	});

	it("rejects a key that is not a valid env identifier", () => {
		expect(parseDevServerEnvPair("1FOO=x")).toHaveProperty("error");
		expect(parseDevServerEnvPair("FOO-BAR=x")).toHaveProperty("error");
		expect(parseDevServerEnvPair("FOO BAR=x")).toHaveProperty("error");
	});

	// The whole point of the blocklist: a caller must not be able to move the
	// server off the port `--wait` polls, or rewrite the pane's PATH.
	it("rejects every name dev3 owns", () => {
		for (const key of [...BLOCKED_DEV_SERVER_ENV_KEYS, "DEV3_PORT0", "DEV3_PORT12"]) {
			expect(parseDevServerEnvPair(`${key}=x`), key).toHaveProperty("error");
		}
	});

	it("allows an unrelated DEV3_-prefixed name", () => {
		expect(isBlockedDevServerEnvKey("DEV3_QA_SCOPE")).toBe(false);
		expect(parseDevServerEnvPair("DEV3_QA_SCOPE=virgin")).toEqual({ key: "DEV3_QA_SCOPE", value: "virgin" });
	});
});

describe("sanitizeDevServerEnv", () => {
	it("drops blocked and malformed keys and keeps the rest", () => {
		expect(sanitizeDevServerEnv({
			DEV3_QA_SCOPE: "seeded",
			PATH: "/evil",
			DEV3_PORT0: "1",
			"BAD-KEY": "x",
			OK: "1",
		})).toEqual({ DEV3_QA_SCOPE: "seeded", OK: "1" });
	});

	it("returns an empty map for undefined", () => {
		expect(sanitizeDevServerEnv(undefined)).toEqual({});
	});
});

describe("dev-server env store", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-env-store-"));
		process.env.DEV3_TEST_ROOT = root;
		vi.resetModules();
	});

	afterEach(() => {
		delete process.env.DEV3_TEST_ROOT;
		rmSync(root, { recursive: true, force: true });
	});

	// DEV3_TEST_ROOT is read at import time, so the store must be imported fresh
	// inside each test rather than at the top of the file.
	async function store() {
		return await import("../dev-server-env-store");
	}

	it("round-trips an env map", async () => {
		const { saveDevServerEnv, readDevServerEnv } = await store();
		saveDevServerEnv("task-1", { DEV3_QA_SCOPE: "seeded" });
		expect(readDevServerEnv("task-1")).toEqual({ DEV3_QA_SCOPE: "seeded" });
	});

	it("reads {} for a task that never started with extra env", async () => {
		const { readDevServerEnv } = await store();
		expect(readDevServerEnv("task-unknown")).toEqual({});
	});

	it("saving an empty map removes the file, so a later read is not stale", async () => {
		const { saveDevServerEnv, readDevServerEnv } = await store();
		saveDevServerEnv("task-2", { A: "1" });
		saveDevServerEnv("task-2", {});
		expect(readDevServerEnv("task-2")).toEqual({});
	});

	it("clear removes what a stop must not leave behind", async () => {
		const { saveDevServerEnv, readDevServerEnv, clearDevServerEnv } = await store();
		saveDevServerEnv("task-3", { A: "1" });
		clearDevServerEnv("task-3");
		expect(readDevServerEnv("task-3")).toEqual({});
	});

	// A scratch file is not a reason to refuse a restart.
	it("reads {} from a corrupt file instead of throwing", async () => {
		const { readDevServerEnv } = await store();
		writeFileSync(join(root, "dev3-task-4-dev-server-env.json"), "{not json", "utf-8");
		expect(readDevServerEnv("task-4")).toEqual({});
	});

	// A file written by an older build (or edited by hand) must not smuggle a
	// blocked name past the handler.
	it("sanitizes what it reads back", async () => {
		const { readDevServerEnv } = await store();
		writeFileSync(
			join(root, "dev3-task-5-dev-server-env.json"),
			JSON.stringify({ DEV3_PORT0: "1", PATH: "/evil", KEEP: "yes" }),
			"utf-8",
		);
		expect(readDevServerEnv("task-5")).toEqual({ KEEP: "yes" });
	});
});
