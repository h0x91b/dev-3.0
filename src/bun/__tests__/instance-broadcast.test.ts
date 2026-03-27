import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We test discoverPeerSockets by mocking the module-level constants
// via a dynamic import pattern. Instead, we test the exported function
// after patching DEV3_HOME.

// Mock DEV3_HOME to a temp directory
const tempDir = mkdtempSync(join(tmpdir(), "dev3-broadcast-test-"));
const socketsDir = join(tempDir, "sockets");

vi.mock("../paths", () => ({
	DEV3_HOME: tempDir,
}));

const { discoverPeerSockets } = await import("../instance-broadcast");

beforeEach(() => {
	mkdirSync(socketsDir, { recursive: true });
});

afterEach(() => {
	// Clean up socket files
	if (existsSync(socketsDir)) {
		for (const f of readdirSync(socketsDir)) {
			try { unlinkSync(join(socketsDir, f)); } catch { /* */ }
		}
	}
});

describe("discoverPeerSockets", () => {
	it("returns empty array when sockets dir does not exist", () => {
		rmSync(socketsDir, { recursive: true, force: true });
		expect(discoverPeerSockets()).toEqual([]);
	});

	it("returns empty array when no socket files exist", () => {
		expect(discoverPeerSockets()).toEqual([]);
	});

	it("skips own PID socket", () => {
		const ownSocket = join(socketsDir, `${process.pid}.sock`);
		writeFileSync(ownSocket, "");
		expect(discoverPeerSockets()).toEqual([]);
	});

	it("removes stale socket for dead PID", () => {
		// Use PID 999999 which almost certainly doesn't exist
		const staleSocket = join(socketsDir, "999999.sock");
		writeFileSync(staleSocket, "");
		expect(existsSync(staleSocket)).toBe(true);

		const peers = discoverPeerSockets();
		expect(peers).toEqual([]);
		// Stale socket should be cleaned up
		expect(existsSync(staleSocket)).toBe(false);
	});

	it("returns socket path for alive peer PID", () => {
		// Use parent process PID — guaranteed alive during test
		const ppid = process.ppid;
		const aliveSocket = join(socketsDir, `${ppid}.sock`);
		writeFileSync(aliveSocket, "");

		const peers = discoverPeerSockets();
		expect(peers).toEqual([aliveSocket]);
	});

	it("skips non-.sock files", () => {
		const ppid = process.ppid;
		writeFileSync(join(socketsDir, "readme.txt"), "");
		writeFileSync(join(socketsDir, `${ppid}.sock`), "");
		const peers = discoverPeerSockets();
		// Only the .sock file for the alive PID
		expect(peers.length).toBe(1);
	});

	it("skips files with non-numeric PID names", () => {
		writeFileSync(join(socketsDir, "abc.sock"), "");
		expect(discoverPeerSockets()).toEqual([]);
	});
});
