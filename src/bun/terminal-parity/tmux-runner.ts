/**
 * tmux implementation of the test-only {@link ParityRunner} (MIG-001).
 *
 * Drives a REAL tmux server on a throwaway socket through the typed
 * {@link TmuxClient} — the same boundary production uses. No raw tmux argv or
 * `-F` format strings appear here as literals; every operation goes through a
 * typed client method or a typed format declaration, so the parity corpus is
 * proved against the actual tmux grammar, not a mock.
 *
 * The client's spawn seam is injected with a `node:child_process` adapter
 * because the vitest environment stubs the Bun global (same approach as
 * `tmux/__tests__/tmux-client-live-e2e.test.ts`). Interactive attach rides a
 * real Bun PTY and is therefore out of this runner's reach — scenarios needing
 * it are marked `gap` in the corpus, not faked here.
 */
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxClient } from "../tmux/client";
import { PANE_SWITCHER_FORMAT } from "../tmux/formats";
import type {
	CaptureOptions,
	CleanupOptions,
	CreateSessionOptions,
	LogicalSessionId,
	LogicalViewId,
	ParityRunner,
	SessionHandle,
	SplitViewOptions,
	ViewInfo,
} from "./runner";

/** Bun-spawn-shaped adapter over node:child_process for TmuxClient's seam. */
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

let socketCounter = 0;

class TmuxParityRunner implements ParityRunner {
	readonly backend = "tmux";
	private readonly client: TmuxClient;
	private readonly created = new Set<LogicalSessionId>();

	constructor(
		private readonly socket: string,
		private readonly workDir: string,
		/** Only the owner tears down the shared socket + workdir on dispose. */
		private readonly owner: boolean,
	) {
		this.client = new TmuxClient({ spawn: nodeSpawnAdapter as never, socket });
	}

	async createSession(opts: CreateSessionOptions): Promise<SessionHandle> {
		await this.client.newSessionDetached({
			sessionName: opts.id,
			cwd: opts.cwd,
			env: opts.env,
			command: opts.command ?? "sh",
		});
		this.created.add(opts.id);
		const firstViewId = await this.client.activePaneId(opts.id);
		if (!firstViewId) throw new Error(`created session ${opts.id} reported no initial view`);
		return { id: opts.id, firstViewId };
	}

	isSessionPresent(id: LogicalSessionId): Promise<boolean> {
		return this.client.hasSession(id);
	}

	async listViews(id: LogicalSessionId): Promise<ViewInfo[]> {
		const rows = await this.client.listPanes(PANE_SWITCHER_FORMAT, { target: id, scope: "session" });
		return rows.map((row) => ({ id: row.paneId, active: row.active }));
	}

	activeViewId(id: LogicalSessionId): Promise<LogicalViewId | null> {
		return this.client.activePaneId(id);
	}

	async splitView(id: LogicalSessionId, from: LogicalViewId, opts: SplitViewOptions): Promise<ViewInfo> {
		const { paneId } = await this.client.splitWindow({
			target: from,
			orientation: "vertical",
			cwd: opts.cwd,
			env: opts.env,
			command: opts.command,
			printPaneId: true,
		});
		if (!paneId) throw new Error(`split of view ${from} returned no new view id`);
		const active = await this.activeViewId(id);
		return { id: paneId, active: active === paneId };
	}

	focusView(_id: LogicalSessionId, view: LogicalViewId): Promise<void> {
		return this.client.selectPane(view);
	}

	sendInput(_id: LogicalSessionId, view: LogicalViewId, text: string): Promise<void> {
		// Two key arguments: the literal line, then the Enter key — exactly how a
		// product input event reaches a shell (mirrors the live client test).
		return this.client.sendKeys(view, [text, "Enter"]);
	}

	capture(_id: LogicalSessionId, view: LogicalViewId, opts?: CaptureOptions): Promise<string> {
		return this.client.capturePane({
			target: view,
			// Plain text (no escapes) keeps content assertions readable; history is
			// pulled with a bounded negative start line so a burst is fully visible.
			startLine: opts?.includeHistory ? -3000 : undefined,
		});
	}

	killView(_id: LogicalSessionId, view: LogicalViewId, opts?: CleanupOptions): Promise<void> {
		return this.client.killPane(view, { bestEffort: opts?.bestEffort });
	}

	cleanupSession(id: LogicalSessionId, opts?: CleanupOptions): Promise<void> {
		return this.client.killSession(id, { bestEffort: opts?.bestEffort });
	}

	/** Build a fresh controller bound to the SAME tmux socket (reconnect model). */
	reconnect(): ParityRunner {
		return new TmuxParityRunner(this.socket, this.workDir, false);
	}

	async dispose(): Promise<void> {
		if (!this.owner) return; // a reconnected client owns no shared resources
		for (const id of this.created) {
			await this.client.killSession(id, { bestEffort: true }).catch(() => {});
		}
		rmSync(this.workDir, { recursive: true, force: true });
	}
}

export interface TmuxParityHarness {
	readonly runner: ParityRunner;
	/** A writable directory checks may use as a session/view cwd. */
	readonly workDir: string;
	/** A fresh controller on the same tmux socket (for the reconnect scenario). */
	reconnect(): ParityRunner;
}

/** Detect a usable tmux on PATH; returns its version string or null. */
export function detectTmux(): string | null {
	try {
		const out = execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim();
		return /^tmux \d/.test(out) ? out : null;
	} catch {
		return null;
	}
}

/** Create an owner tmux parity runner on a fresh throwaway socket + workdir. */
export function createTmuxParityHarness(): TmuxParityHarness {
	const socket = `dev3-parity-${process.pid}-${socketCounter++}`;
	const workDir = mkdtempSync(join(tmpdir(), "dev3-parity-"));
	const runner = new TmuxParityRunner(socket, workDir, true);
	return {
		runner,
		workDir,
		reconnect: () => (runner as TmuxParityRunner).reconnect(),
	};
}
