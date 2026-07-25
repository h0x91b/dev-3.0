/**
 * Proves the tmux adapter satisfies the product contract against a REAL tmux
 * server on a throwaway socket — the grammar the in-memory conformance suite
 * cannot check (literal input bytes, `resize-window` on a detached session,
 * pane-id stability for a fresh controller).
 *
 * Excluded from the fast suite (see the `test` script's
 * `--exclude '**\/tmux-backend.live-e2e*'`); runs in `bun run test:full`.
 * Skips entirely when tmux is not on PATH.
 */

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxClient } from "../../tmux/client";
import { PANE_GEOMETRY_FORMAT } from "../../tmux/formats";
import { TmuxTerminalBackend } from "../tmux-backend";
import { tmuxBackendPort } from "../tmux-port";
import { isTerminalBackendError } from "../errors";

/** Bun-spawn-shaped adapter over node:child_process (vitest stubs the Bun global). */
function nodeSpawnAdapter(cmd: string[], opts?: { cwd?: string }) {
	const child = nodeSpawn(cmd[0], cmd.slice(1), { cwd: opts?.cwd, env: process.env });
	return {
		pid: child.pid ?? 0,
		kill: () => child.kill(),
		stdout: Readable.toWeb(child.stdout!),
		stderr: Readable.toWeb(child.stderr!),
		exited: new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1))),
	};
}

function detectTmux(): string | null {
	try {
		const out = execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim();
		return /^tmux \d/.test(out) ? out : null;
	} catch {
		return null;
	}
}

const TMUX_VERSION = detectTmux();
const SESSION = `dev3seam${process.pid}`;

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("condition did not become true in time");
}

describe.skipIf(!TMUX_VERSION || process.platform === "win32")(
	"TmuxTerminalBackend against a real tmux server",
	() => {
		const socket = `dev3-seam-${process.pid}`;
		let workDir: string;
		let client: TmuxClient;
		let backend: TmuxTerminalBackend;

		beforeAll(() => {
			workDir = mkdtempSync(join(tmpdir(), "dev3-seam-"));
			client = new TmuxClient({ spawn: nodeSpawnAdapter as never, socket });
			backend = new TmuxTerminalBackend({ port: tmuxBackendPort(client) });
		});

		afterAll(async () => {
			await backend.dispose();
			await client.killSession(SESSION, { bestEffort: true }).catch(() => {});
			rmSync(workDir, { recursive: true, force: true });
		});

		it("runs the single-view lifecycle end to end", async () => {
			const created = await backend.openSession({
				id: SESSION,
				cwd: workDir,
				command: "sh",
				size: { cols: 100, rows: 30 },
			});
			expect(created.views).toHaveLength(1);

			const geometry = await client.displayMessage(PANE_GEOMETRY_FORMAT, { target: SESSION });
			expect({ cols: geometry?.width, rows: geometry?.height }).toEqual({ cols: 100, rows: 30 });

			const attachment = await backend.attachView(SESSION);
			await attachment.write("echo seam-live\r");
			await eventually(async () => (await attachment.capture()).text.includes("seam-live"));

			await attachment.resize({ cols: 120, rows: 40 });
			const resized = await client.displayMessage(PANE_GEOMETRY_FORMAT, { target: SESSION });
			expect({ cols: resized?.width, rows: resized?.height }).toEqual({ cols: 120, rows: 40 });

			// A fresh controller rediscovers the same view id and reads the same text.
			const fresh = new TmuxTerminalBackend({ port: tmuxBackendPort(client) });
			const rediscovered = await fresh.describeSession(SESSION);
			expect(rediscovered?.views.map((view) => view.id)).toEqual(
				created.views.map((view) => view.id),
			);
			const reattached = await fresh.attachView(SESSION);
			expect((await reattached.capture()).text).toContain("seam-live");
			await fresh.dispose();

			const second = await backend.splitView(SESSION, created.views[0].id, { cwd: workDir });
			const split = await backend.describeSession(SESSION);
			expect(split?.views.map((view) => view.id)).toEqual([created.views[0].id, second.id]);
			await backend.focusView(SESSION, created.views[0].id);
			expect((await backend.describeSession(SESSION))?.focusedViewId).toBe(created.views[0].id);

			await backend.closeView(SESSION, second.id);
			expect((await backend.describeSession(SESSION))?.views).toHaveLength(1);

			await backend.cleanupSession(SESSION);
			await expect(backend.describeSession(SESSION)).resolves.toBeNull();
			await expect(backend.cleanupSession(SESSION, { ignoreMissing: true })).resolves.toBeUndefined();
			const err = await backend.cleanupSession(SESSION).catch((e) => e);
			expect(isTerminalBackendError(err) && err.code).toBe("session-not-found");
		});
	},
);
