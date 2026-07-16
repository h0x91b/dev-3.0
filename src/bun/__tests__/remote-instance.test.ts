import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	_resetRemoteInstanceForTests,
	getOrCreateRemoteInstanceId,
	getRemoteInstanceInfo,
} from "../remote-instance";

const testDir = join(tmpdir(), `dev3-remote-instance-test-${process.pid}`);
const instanceFile = join(testDir, "remote-instance-id");

afterEach(() => {
	_resetRemoteInstanceForTests();
	rmSync(testDir, { recursive: true, force: true });
});

describe("remote instance identity", () => {
	it("creates a stable additive UUID file with private permissions", () => {
		const first = getOrCreateRemoteInstanceId(instanceFile);
		const second = getOrCreateRemoteInstanceId(instanceFile);

		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).toBe(first);
		expect(readFileSync(instanceFile, "utf8").trim()).toBe(first);
		expect(statSync(instanceFile).mode & 0o777).toBe(0o600);
	});

	it("repairs a corrupt identity in place without moving the file", () => {
		mkdirSync(testDir, { recursive: true });
		writeFileSync(instanceFile, "corrupt\n");
		const beforeInode = statSync(instanceFile).ino;

		const repaired = getOrCreateRemoteInstanceId(instanceFile);

		expect(repaired).toMatch(/^[0-9a-f-]{36}$/);
		expect(statSync(instanceFile).ino).toBe(beforeInode);
		expect(readFileSync(instanceFile, "utf8").trim()).toBe(repaired);
	});

	it("falls back to a process-stable identity when persistence is unavailable", () => {
		mkdirSync(testDir, { recursive: true });
		const blockingFile = join(testDir, "not-a-directory");
		writeFileSync(blockingFile, "block");
		const unavailablePath = join(blockingFile, "remote-instance-id");

		expect(getOrCreateRemoteInstanceId(unavailablePath)).toBe(
			getOrCreateRemoteInstanceId(unavailablePath),
		);
	});

	it("builds the exact unauthenticated discovery payload", () => {
		const info = getRemoteInstanceInfo({
			instanceIdPath: instanceFile,
			name: "studio-mac",
			appVersion: "9.8.7",
		});

		expect(info).toEqual({
			instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			name: "studio-mac",
			appVersion: "9.8.7",
			protocolVersion: 1,
		});
	});
});
