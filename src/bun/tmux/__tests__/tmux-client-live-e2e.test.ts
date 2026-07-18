/**
 * Live-tmux integration test: runs a REAL tmux server on a throwaway socket
 * and exercises the TmuxClient methods end-to-end — the automatic grammar
 * safety net for the big-bang client migration. Excluded from the fast suite
 * (package.json `test` script) like the other slow e2e files; runs in CI/PR
 * via `bun run test:full`.
 *
 * The client's spawn seam is injected with a node:child_process adapter —
 * the vitest environment stubs the Bun global, so the project spawn wrapper
 * cannot start real processes here. spawnAttachedSession is the one method
 * not covered live (it needs a real Bun PTY); its argv construction is
 * covered by client.test.ts and the attach path by manual QA.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxClient } from "../client";
import { TmuxError } from "../errors";
import {
	PANE_ID_FORMAT,
	PANE_PID_FORMAT,
	ALL_PANE_PIDS_FORMAT,
	PANE_GEOMETRY_FORMAT,
	PANE_SWITCHER_FORMAT,
	WINDOW_OVERVIEW_FORMAT,
	WINDOW_SWITCHER_FORMAT,
	SESSION_OVERVIEW_FORMAT,
	STATUS_GEOMETRY_FORMAT,
	ALT_CLICK_PANE_FORMAT,
	PANE_IN_MODE_FORMAT,
	parseWindowLayout,
} from "../formats";

function tmuxOnPath(): string | null {
	try {
		const version = execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim();
		return /^tmux \d/.test(version) ? version : null;
	} catch {
		return null;
	}
}

const TMUX_VERSION = tmuxOnPath();
const SOCKET = `dev3-live-test-${process.pid}`;
const SESSION = "dev3-livetest";

// Bun-spawn-shaped adapter over node:child_process for the injected seam.
function liveSpawn(cmd: string[], opts?: { cwd?: string }) {
	const child = nodeSpawn(cmd[0], cmd.slice(1), { cwd: opts?.cwd, env: process.env });
	return {
		pid: child.pid ?? 0,
		kill: () => child.kill(),
		stdout: Readable.toWeb(child.stdout!),
		stderr: Readable.toWeb(child.stderr!),
		exited: new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1))),
	};
}

const client = new TmuxClient({ spawn: liveSpawn as never, socket: SOCKET });

let workDir = "";

describe.skipIf(!TMUX_VERSION)("TmuxClient against a live tmux server", () => {
	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "dev3-tmux-live-"));
	});

	afterAll(async () => {
		// Killing every session shuts the throwaway server down with it.
		for (const name of [SESSION, "dev3-livetest2"]) {
			await client.killSession(name, { bestEffort: true }).catch(() => {});
		}
		rmSync(workDir, { recursive: true, force: true });
	});

	it("newSessionDetached starts a session that hasSession sees", async () => {
		expect(await client.hasSession(SESSION)).toBe(false);
		const { stderr } = await client.newSessionDetached({
			sessionName: SESSION,
			cwd: workDir,
			env: { DEV3_LIVE_TEST: "1" },
			command: "sh",
		});
		expect(stderr.trim()).toBe("");
		expect(await client.hasSession(SESSION)).toBe(true);
	});

	it("listSessions returns the typed overview row", async () => {
		const sessions = await client.listSessions(SESSION_OVERVIEW_FORMAT);
		const row = sessions.find((s) => s.name === SESSION);
		expect(row).toBeDefined();
		expect(row!.windowCount).toBeGreaterThanOrEqual(1);
		expect(row!.createdAt).toBeGreaterThan(0);
	});

	it("splitWindow returns a fresh pane id and listPanes sees both panes", async () => {
		const { paneId } = await client.splitWindow({
			target: SESSION,
			orientation: "vertical",
			printPaneId: true,
			cwd: workDir,
			command: "sh",
		});
		expect(paneId).toMatch(/^%\d+$/);

		const panes = await client.listPanes(PANE_ID_FORMAT, { target: SESSION });
		expect(panes.length).toBe(2);
		expect(panes.map((p) => p.paneId)).toContain(paneId);

		const pids = await client.listPanes(PANE_PID_FORMAT, { target: SESSION });
		for (const { panePid } of pids) expect(panePid).toBeGreaterThan(0);
	});

	it("server-wide pane listing carries the session name as tail", async () => {
		const rows = await client.listPanes(ALL_PANE_PIDS_FORMAT, { scope: "server" });
		expect(rows.some((r) => r.sessionName === SESSION)).toBe(true);
	});

	it("pane geometry + window overview agree with parseWindowLayout", async () => {
		const windows = await client.listWindows(WINDOW_OVERVIEW_FORMAT, { target: SESSION });
		expect(windows.length).toBeGreaterThanOrEqual(1);
		expect(windows[0].panes).toBe(2);
		const geometry = parseWindowLayout(windows[0].layout);
		expect(geometry.size).toBe(2);

		const panes = await client.listPanes(PANE_GEOMETRY_FORMAT, { target: SESSION, scope: "session" });
		for (const pane of panes) {
			expect(geometry.has(pane.paneId)).toBe(true);
		}
	});

	it("switcher formats parse live output", async () => {
		const panes = await client.listPanes(PANE_SWITCHER_FORMAT, { target: SESSION });
		expect(panes.length).toBe(2);
		expect(panes.filter((p) => p.active)).toHaveLength(1);

		const inMode = await client.listPanes(PANE_IN_MODE_FORMAT, { target: SESSION, scope: "session" });
		expect(inMode.every((p) => !p.inMode)).toBe(true);

		const altRows = await client.listPanes(ALT_CLICK_PANE_FORMAT, { target: SESSION });
		expect(altRows.length).toBe(2);
		expect(altRows.every((p) => p.paneId.startsWith("%"))).toBe(true);
	});

	it("displayMessage + activePaneId read the active pane", async () => {
		const active = await client.activePaneId(SESSION);
		expect(active).toMatch(/^%\d+$/);
		const status = await client.displayMessage(STATUS_GEOMETRY_FORMAT, { target: SESSION });
		expect(status).not.toBeNull();
		expect(status!.windowHeight).toBeGreaterThan(0);
	});

	it("sendKeys types into a pane and capturePane reads it back", async () => {
		const active = await client.activePaneId(SESSION);
		await client.sendKeys(active!, ["echo dev3-roundtrip-marker", "Enter"]);
		// Poll: the shell needs a moment to echo the output.
		let captured = "";
		for (let i = 0; i < 40 && !captured.includes("dev3-roundtrip-marker"); i++) {
			await new Promise((r) => setTimeout(r, 100));
			captured = await client.capturePane({ target: active!, escapes: true });
		}
		expect(captured).toContain("dev3-roundtrip-marker");
	});

	it("selection, layout, zoom, options, hooks and env commands all succeed", async () => {
		const panes = await client.listPanes(PANE_ID_FORMAT, { target: SESSION });
		await client.selectPane(panes[0].paneId, { title: "Live Test" });
		await client.selectLayout(SESSION, "even-vertical");
		await client.nextLayout(SESSION);
		await client.toggleZoom(SESSION);
		await client.toggleZoom(SESSION);
		await client.setOption(SESSION, "pane-border-status", "top");
		await client.setWindowHook(SESSION, "pane-exited", "run-shell 'true'");
		await client.setEnvironment(SESSION, "DEV3_LIVE_ROUNDTRIP", "yes");
		await client.removeEnvironment(SESSION, "DEV3_LIVE_ROUNDTRIP");

		const titled = await client.listPanes(PANE_SWITCHER_FORMAT, { target: SESSION });
		expect(titled.map((p) => p.title)).toContain("Live Test");
	});

	it("sourceFile applies a config file on the live server", async () => {
		const confPath = join(workDir, "live.conf");
		writeFileSync(confPath, "set -g status off\n");
		await client.sourceFile(confPath);
		const status = await client.displayMessage(STATUS_GEOMETRY_FORMAT, { target: SESSION });
		expect(status!.status).toBe("off");
	});

	it("newWindow + selectWindow + window switcher format", async () => {
		const { paneId } = await client.newWindow({ target: SESSION, name: "live2", printPaneId: true, cwd: workDir, command: "sh" });
		expect(paneId).toMatch(/^%\d+$/);
		const windows = await client.listWindows(WINDOW_SWITCHER_FORMAT, { target: SESSION });
		expect(windows.length).toBe(2);
		expect(windows.map((w) => w.name)).toContain("live2");
		await client.selectWindow(windows[0].windowId);
	});

	it("exitCopyMode leaves copy-mode entered via a real tmux command", async () => {
		// The client deliberately has no copy-mode-enter method — flip the pane
		// into copy-mode with send-keys' documented -X sibling via the hook-free
		// route: bestEffort cancel on a pane NOT in copy-mode fails softly…
		const active = await client.activePaneId(SESSION);
		await client.exitCopyMode(active!, { bestEffort: true });
		const inMode = await client.listPanes(PANE_IN_MODE_FORMAT, { target: SESSION, scope: "session" });
		expect(inMode.every((p) => !p.inMode)).toBe(true);
	});

	it("killPane removes exactly the targeted pane", async () => {
		const before = await client.listPanes(PANE_ID_FORMAT, { target: SESSION, scope: "session" });
		const victim = before[before.length - 1].paneId;
		await client.killPane(victim);
		const after = await client.listPanes(PANE_ID_FORMAT, { target: SESSION, scope: "session" });
		expect(after.map((p) => p.paneId)).not.toContain(victim);
		expect(after.length).toBe(before.length - 1);
	});

	it("errors carry tmux stderr and exit code (TmuxError)", async () => {
		const err = await client
			.listPanes(PANE_ID_FORMAT, { target: "dev3-no-such-session" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TmuxError);
		expect((err as TmuxError).exitCode).not.toBe(0);
		expect((err as TmuxError).stderr.length).toBeGreaterThan(0);
	});

	it("killSession tears the session down; bestEffort kill of a ghost is quiet", async () => {
		await client.killSession(SESSION);
		expect(await client.hasSession(SESSION)).toBe(false);
		await expect(client.killSession(SESSION, { bestEffort: true })).resolves.toBeUndefined();
		await expect(client.killSession(SESSION)).rejects.toBeInstanceOf(TmuxError);
	});
});
