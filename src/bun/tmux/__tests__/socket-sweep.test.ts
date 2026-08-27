import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { probeSocketLiveness, sweepDeadTmuxSockets } from "../socket-sweep";
import { tmuxSocketDir } from "../socket-files";
import { testSocketRoot } from "../../../../test-scoped-path";

let root = "";
let dir = "";
let previousTmpdir: string | undefined;
const servers: net.Server[] = [];

/**
 * A socket file with no listener — exactly what tmux leaves behind. Made the
 * honest way: a child process binds it and is SIGKILLed, so nothing unlinks it.
 * `server.close()` would remove the file and prove nothing.
 */
function orphanedSocketFile(path: string): void {
	// A hard exit skips the unlink that `server.close()` would do, which is
	// exactly how a dead tmux server leaves its socket behind.
	const script = `require("node:net").createServer().listen(${JSON.stringify(path)},()=>process.exit(0));`;
	const child = spawnSync(process.execPath, ["-e", script], { timeout: 10_000 });
	if (!existsSync(path)) throw new Error(`failed to orphan a socket at ${path}: ${child.stderr?.toString() ?? ""}`);
}

/** Backdate a path past SWEEP_MIN_AGE_MS so the age gate does not hide the result. */
function backdate(path: string): void {
	const old = new Date(Date.now() - 10 * 60_000);
	utimesSync(path, old, old);
}

function listenOn(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		servers.push(server);
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
}

beforeEach(() => {
	// The run's short socket root, not its TMPDIR: a unix socket path is capped
	// at ~104 bytes and the isolated TMPDIR blows that on its own.
	root = mkdtempSync(join(testSocketRoot(), "sw-"));
	previousTmpdir = process.env.TMUX_TMPDIR;
	process.env.TMUX_TMPDIR = root;
	dir = tmuxSocketDir();
	mkdirSync(dir, { recursive: true });
});

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
	if (previousTmpdir === undefined) delete process.env.TMUX_TMPDIR;
	else process.env.TMUX_TMPDIR = previousTmpdir;
	rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("probeSocketLiveness", () => {
	it("reports a socket with a listener as listening", async () => {
		const path = join(dir, "dev3-live-probe");
		await listenOn(path);
		expect(await probeSocketLiveness(path)).toBe("listening");
	});

	it("reports an orphaned socket file — the whole point of this module — as dead", async () => {
		const path = join(dir, "dev3-orphan-probe");
		orphanedSocketFile(path);
		expect(statSync(path).isSocket()).toBe(true);
		expect(await probeSocketLiveness(path)).toBe("dead");
	});

	it("reports a path that is not there as dead", async () => {
		expect(await probeSocketLiveness(join(dir, "dev3-never-existed"))).toBe("dead");
	});
});

describe.skipIf(process.platform === "win32")("sweepDeadTmuxSockets", () => {
	it("removes an orphaned dev3 socket and leaves a live one alone", async () => {
		const orphan = join(dir, "dev3-live-test-99991");
		const alive = join(dir, "dev3-live-test-99992");
		orphanedSocketFile(orphan);
		backdate(orphan);
		await listenOn(alive);
		backdate(alive);

		const result = await sweepDeadTmuxSockets();

		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(alive)).toBe(true);
		expect(result.removed).toBe(1);
	});

	it("leaves a non-dev3 socket, a plain file and a fresh socket untouched", async () => {
		const foreign = join(dir, "default");
		const plainFile = join(dir, "dev3-not-a-socket");
		const fresh = join(dir, "dev3-live-test-99993");
		orphanedSocketFile(foreign);
		backdate(foreign);
		writeFileSync(plainFile, "");
		backdate(plainFile);
		orphanedSocketFile(fresh); // deliberately NOT backdated

		const result = await sweepDeadTmuxSockets();

		expect(existsSync(foreign)).toBe(true);
		expect(existsSync(plainFile)).toBe(true);
		expect(existsSync(fresh)).toBe(true);
		expect(result.removed).toBe(0);
	});
});
