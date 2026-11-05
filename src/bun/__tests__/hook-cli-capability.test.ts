import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { hookCliSupports, resetHookCliCapabilityCacheForTests } from "../hook-cli-capability";

describe("hookCliSupports", () => {
	let dir = "";
	let cli = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dev3-hook-cli-"));
		cli = join(dir, "dev3");
		resetHookCliCapabilityCacheForTests();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("finds a method name compiled into the CLI binary", async () => {
		writeFileSync(cli, Buffer.concat([Buffer.alloc(4096, 0), Buffer.from('sendRequest(s,"agent.sessionStarted",{'), Buffer.alloc(64, 1)]));
		expect(await hookCliSupports("agent.sessionStarted", cli)).toBe(true);
		expect(await hookCliSupports("agent.exited", cli)).toBe(false);
	});

	it("re-reads after the managed CLI is replaced", async () => {
		writeFileSync(cli, "old cli");
		expect(await hookCliSupports("agent.exited", cli)).toBe(false);
		writeFileSync(cli, 'new cli "agent.exited"');
		const later = new Date(Date.now() + 5_000);
		utimesSync(cli, later, later);
		expect(await hookCliSupports("agent.exited", cli)).toBe(true);
	});

	it("answers false when there is no CLI to read", async () => {
		expect(await hookCliSupports("agent.exited", join(dir, "missing"))).toBe(false);
	});
});
