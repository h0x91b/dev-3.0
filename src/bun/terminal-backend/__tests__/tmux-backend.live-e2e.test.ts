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

		// Real tmux round-trips plus a 60-row scroll need more than the 5s default.
		it("runs the single-view lifecycle end to end", { timeout: 30_000 }, async () => {
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
			await eventually(async () => {
				const capture = await backend.captureView(SESSION, created.views[0].id);
				return capture.availability === "captured" && capture.content.viewport.join("\n").includes("seam-live");
			});

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
			expect(reattached.viewId).toBe(created.views[0].id);
			const freshCapture = await fresh.captureView(SESSION, created.views[0].id);
			if (freshCapture.availability !== "captured") throw new Error(`capture missed: ${freshCapture.availability}`);
			expect(freshCapture.content.viewport.join("\n")).toContain("seam-live");
			// Real tmux reads the live screen, so it can vouch for currency — and cannot
			// say when that screen last changed.
			expect(freshCapture.freshness).toEqual({ known: true, value: "current" });
			expect(freshCapture.lastChangeAgeMs.known).toBe(false);
			expect(freshCapture.content.lineModel).toBe("physical-rows");
			expect(freshCapture.identity.incarnation.known).toBe(true);
			await fresh.dispose();

			const second = await backend.splitView(SESSION, created.views[0].id, { cwd: workDir });
			const split = await backend.describeSession(SESSION);
			expect(split?.views.map((view) => view.id)).toEqual([created.views[0].id, second.id]);
			await backend.focusView(SESSION, created.views[0].id);
			expect((await backend.describeSession(SESSION))?.focusedViewId).toBe(created.views[0].id);

			await backend.closeView(SESSION, second.id);
			expect((await backend.describeSession(SESSION))?.views).toHaveLength(1);

			// Read-only capture against the real server (seq 1412): the split of
			// viewport vs scrollback is tmux grammar the in-memory world cannot prove,
			// because `-S -N -E -1` addressing is tmux's own line numbering.
			const attach = await backend.attachView(SESSION, created.views[0].id);
			// One shell invocation, 60 rows: 60 separate send-keys against a real
			// server is slow enough to dominate the test's whole budget.
			await attach.write("for i in $(seq 0 59); do echo live-row-$i; done\r");
			await attach.detach();
			await eventually(async () => {
				const c = await backend.captureView(SESSION, created.views[0].id);
				return c.availability === "captured" && c.content.viewport.join("\n").includes("live-row-59");
			});
			const deep = await backend.captureView(SESSION, created.views[0].id, { historyLines: 200 });
			if (deep.availability !== "captured") throw new Error(`capture missed: ${deep.availability}`);
			expect(deep.content.history.length).toBeGreaterThan(0);
			expect(deep.content.history.join("\n")).toContain("live-row-0");
			// History ends immediately ABOVE the screen: no row is in both halves.
			for (const row of deep.content.viewport) {
				if (row.trim() !== "") expect(deep.content.history).not.toContain(row);
			}
			expect(deep.bounds.historyLinesAvailable.known).toBe(true);
			expect(deep.size).toEqual({ known: true, value: { cols: 120, rows: 40 } });
			// Real tmux output carries real escape sequences; none may reach a caller.
			const rows = [...deep.content.history, ...deep.content.viewport];
			expect(rows.some((row) => /[\u0000-\u001F\u007F-\u009F]/.test(row))).toBe(false);
			expect(deep.gaps.known).toBe(false);

			await backend.cleanupSession(SESSION);
			await expect(backend.describeSession(SESSION)).resolves.toBeNull();
			await expect(backend.cleanupSession(SESSION, { ignoreMissing: true })).resolves.toBeUndefined();
			const err = await backend.cleanupSession(SESSION).catch((e) => e);
			expect(isTerminalBackendError(err) && err.code).toBe("session-not-found");
		});
	},
);
