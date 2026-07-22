/**
 * TmuxClient — the ONE place that builds tmux argv, spawns the tmux binary,
 * and parses its output. Every used subcommand is a typed method; format
 * strings live in ./formats, session names in ./session-names, binary/shim
 * selection in ./binary. There is deliberately NO public "run raw args"
 * escape hatch: a new tmux command means a new method plus its test.
 *
 * All production code imports the `tmux` singleton below; tests either mock
 * this module (handler tests) or construct a TmuxClient with an injected
 * fake spawn (client tests).
 *
 * HARD RULE (AGENTS.md): never spawn `tmux` directly anywhere else in the
 * codebase — a bare PATH `tmux` may be a different version than the one the
 * app committed to, and mixed client/server versions break every command
 * (v1.29.1 ELOOP incident, decision 105).
 */
import { spawn as defaultSpawn } from "../spawn";
import {
	dereferenceTmuxShim,
	getTmuxBinary,
	probeTmuxVersion,
	selectTmuxBinary,
} from "./binary";
import { DEFAULT_TMUX_SOCKET } from "./constants";
import { tmuxClientCwd } from "./config";
import { TmuxError, TmuxSpawnError } from "./errors";
import type { TmuxFormat } from "./formats";
import { PANE_ID_FORMAT } from "./formats";

type SpawnFn = typeof defaultSpawn;
type SpawnedProcess = ReturnType<SpawnFn>;

export interface TmuxClientOptions {
	/** Spawn implementation — defaults to the PATH-patched project wrapper. */
	spawn?: SpawnFn;
	/** Default tmux socket for calls that don't pass one. */
	socket?: string;
}

interface SocketOpt {
	socket?: string;
}

/** Options common to fire-and-forget commands. */
interface CommandOpts extends SocketOpt {
	/** Swallow a non-zero tmux exit (TmuxError) — launch failures still throw. */
	bestEffort?: boolean;
}

export type SplitOrientation = "vertical" | "horizontal";

export type TmuxLayoutName =
	| "tiled"
	| "even-horizontal"
	| "even-vertical"
	| "main-horizontal"
	| "main-vertical";

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class TmuxClient {
	private readonly spawnFn: SpawnFn;
	readonly defaultSocket: string;

	constructor(opts: TmuxClientOptions = {}) {
		this.spawnFn = opts.spawn ?? defaultSpawn;
		this.defaultSocket = opts.socket ?? DEFAULT_TMUX_SOCKET;
	}

	// ── Binary surface (delegates to ./binary — the only path to it) ──

	/**
	 * Resolved tmux binary path. For embedding into shell scripts that must
	 * talk to the same server (a PATH tmux of a different version cannot).
	 * Never use this to spawn tmux yourself — add a client method instead.
	 */
	binaryPath(): string {
		return getTmuxBinary();
	}

	/** Commit to a tmux binary for this app session (see ./binary). */
	selectBinary(preferred: string, fallbackCandidates: string[] = []): Promise<string | undefined> {
		return selectTmuxBinary(preferred, fallbackCandidates);
	}

	/** `tmux -V` probe — the version string, or undefined when not a tmux. */
	probeVersion(binary: string): Promise<string | undefined> {
		return probeTmuxVersion(binary);
	}

	/** Resolve a candidate path that may be the dev3 PATH shim (see ./binary). */
	dereferenceShim(binaryPath: string): string | undefined {
		return dereferenceTmuxShim(binaryPath);
	}

	// ── Core runner (private — no raw-args escape hatch) ──────────────

	private argv(socket: string | undefined, args: string[]): string[] {
		return [getTmuxBinary(), "-L", socket ?? this.defaultSocket, ...args];
	}

	private async run(socket: string | undefined, args: string[]): Promise<RunResult> {
		let proc: SpawnedProcess;
		try {
			proc = this.spawnFn(this.argv(socket, args), { stdout: "pipe", stderr: "pipe" });
		} catch (err) {
			throw new TmuxSpawnError(getTmuxBinary(), err);
		}
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	private async runChecked(socket: string | undefined, args: string[]): Promise<RunResult> {
		const result = await this.run(socket, args);
		if (result.exitCode !== 0) throw new TmuxError(args, result.exitCode, result.stderr);
		return result;
	}

	private async runCommand(socket: string | undefined, args: string[], opts?: CommandOpts): Promise<void> {
		if (opts?.bestEffort) {
			try {
				await this.runChecked(socket, args);
			} catch (err) {
				if (!(err instanceof TmuxError)) throw err;
			}
			return;
		}
		await this.runChecked(socket, args);
	}

	// ── Sessions ───────────────────────────────────────────────────────

	/** `has-session -t` — true when the session exists on the socket. */
	async hasSession(session: string, opts?: SocketOpt): Promise<boolean> {
		return (await this.run(opts?.socket, ["has-session", "-t", session])).exitCode === 0;
	}

	/** `kill-session -t`. */
	killSession(session: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["kill-session", "-t", session], opts);
	}

	/** `list-sessions -F` parsed through a typed format declaration. */
	async listSessions<T>(format: TmuxFormat<T>, opts?: SocketOpt): Promise<T[]> {
		const { stdout } = await this.runChecked(opts?.socket, ["list-sessions", "-F", format.formatString]);
		return format.parse(stdout);
	}

	/**
	 * `new-session -d` — start a DETACHED session running `command`.
	 * Env vars ride on `-e` so they land in session-environment atomically.
	 * Returns captured stderr: tmux prints warnings there even on success.
	 */
	async newSessionDetached(opts: {
		sessionName: string;
		/** Pane working directory (`-c`) — REQUIRED; the client process itself
		 *  always starts from tmuxClientCwd() (decision 103). */
		cwd: string;
		env?: Record<string, string>;
		command?: string;
	} & SocketOpt): Promise<{ stderr: string }> {
		const args = ["new-session", "-d"];
		for (const [key, value] of Object.entries(opts.env ?? {})) {
			args.push("-e", `${key}=${value}`);
		}
		args.push("-s", opts.sessionName, "-c", opts.cwd);
		if (opts.command) args.push(opts.command);
		let proc: SpawnedProcess;
		try {
			proc = this.spawnFn(this.argv(opts.socket, args), {
				stdout: "pipe",
				stderr: "pipe",
				// A tmux server started by this client keeps the client cwd forever —
				// it must never be a mortal task worktree (decision 103).
				cwd: tmuxClientCwd(),
			});
		} catch (err) {
			throw new TmuxSpawnError(getTmuxBinary(), err);
		}
		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new TmuxError(args, exitCode, stderr);
		return { stderr };
	}

	/**
	 * Spawn an ATTACHED tmux client on a Bun PTY (`new-session`, optionally
	 * `-A` to attach when the session already exists). This is the interactive
	 * path behind every task/project terminal and the cleanup-script session.
	 * Returns the raw child process — the caller owns its lifecycle.
	 * Launch-time failures throw TmuxSpawnError (decision 123).
	 */
	spawnAttachedSession(opts: {
		sessionName: string;
		/** Themed config file passed via `-f` (only applies to a fresh server). */
		configFile: string;
		/** Pane working directory (`-c`); client cwd is pinned to tmuxClientCwd(). */
		cwd: string;
		/** `-A`: attach if the session already exists instead of failing. */
		attachIfExists?: boolean;
		/** Session env vars passed via `-e KEY=VAL` flags. */
		envFlags?: Record<string, string>;
		command?: string;
		terminal: { cols: number; rows: number; data: (terminal: unknown, data: string | Uint8Array) => void };
		/** Environment for the client PROCESS itself (not the session env). */
		processEnv?: Record<string, string>;
	} & SocketOpt): SpawnedProcess {
		const args = ["-f", opts.configFile, "new-session"];
		if (opts.attachIfExists) args.push("-A");
		args.push("-c", opts.cwd);
		for (const [key, value] of Object.entries(opts.envFlags ?? {})) {
			args.push("-e", `${key}=${value}`);
		}
		args.push("-s", opts.sessionName);
		if (opts.command) args.push(opts.command);
		const argv = [getTmuxBinary(), "-L", opts.socket ?? this.defaultSocket, ...args];
		try {
			return this.spawnFn(argv, {
				terminal: opts.terminal,
				env: opts.processEnv,
				cwd: tmuxClientCwd(),
			});
		} catch (err) {
			throw new TmuxSpawnError(getTmuxBinary(), err);
		}
	}

	// ── Panes & windows ────────────────────────────────────────────────

	/**
	 * `list-panes` parsed through a typed format declaration.
	 * scope "window" (default) = current window of `target`;
	 * "session" = every window of `target` (`-s`); "server" = all sessions (`-a`).
	 */
	async listPanes<T>(format: TmuxFormat<T>, opts: {
		target?: string;
		scope?: "window" | "session" | "server";
	} & SocketOpt): Promise<T[]> {
		const args = ["list-panes"];
		if (opts.scope === "server") {
			args.push("-a");
		} else {
			if (opts.scope === "session") args.push("-s");
			if (!opts.target) throw new Error("tmux list-panes: target is required unless scope is \"server\"");
			args.push("-t", opts.target);
		}
		args.push("-F", format.formatString);
		const { stdout } = await this.runChecked(opts.socket, args);
		return format.parse(stdout);
	}

	/** `list-windows -t` parsed through a typed format declaration. */
	async listWindows<T>(format: TmuxFormat<T>, opts: { target: string } & SocketOpt): Promise<T[]> {
		const { stdout } = await this.runChecked(opts.socket, ["list-windows", "-t", opts.target, "-F", format.formatString]);
		return format.parse(stdout);
	}

	/** `display-message -p -t` — one formatted line about the active pane/window. */
	async displayMessage<T>(format: TmuxFormat<T>, opts: { target: string } & SocketOpt): Promise<T | null> {
		const { stdout } = await this.runChecked(opts.socket, ["display-message", "-p", "-t", opts.target, format.formatString]);
		return format.parse(stdout)[0] ?? null;
	}

	/** The active pane id (`%N`) of a session, or null when unavailable. */
	async activePaneId(target: string, opts?: SocketOpt): Promise<string | null> {
		const row = await this.displayMessage(PANE_ID_FORMAT, { target, socket: opts?.socket });
		return row?.paneId || null;
	}

	/**
	 * `split-window` — returns the new pane id when `printPaneId` is set, plus
	 * captured stderr (some callers log it even on success).
	 */
	async splitWindow(opts: {
		target: string;
		/** tmux `-v` splits vertically (new pane BELOW), `-h` horizontally (RIGHT). */
		orientation: SplitOrientation;
		/** `-b`: place the new pane before (above/left of) the target. */
		before?: boolean;
		/** `-l`: size of the new pane, e.g. "40%" or "20". */
		size?: string;
		/** `-P -F #{pane_id}`: print the new pane id. */
		printPaneId?: boolean;
		/** `-e KEY=VAL` session-env entries visible to the new pane. */
		env?: Record<string, string>;
		/** `-c`: working directory (may be a tmux format like PANE_CWD_FORMAT). */
		cwd?: string;
		command?: string;
	} & SocketOpt): Promise<{ paneId: string | null; stderr: string }> {
		const args = ["split-window", opts.orientation === "vertical" ? "-v" : "-h"];
		if (opts.before) args.push("-b");
		if (opts.size) args.push("-l", opts.size);
		if (opts.printPaneId) args.push("-P", "-F", PANE_ID_FORMAT.formatString);
		for (const [key, value] of Object.entries(opts.env ?? {})) {
			args.push("-e", `${key}=${value}`);
		}
		args.push("-t", opts.target);
		if (opts.cwd) args.push("-c", opts.cwd);
		if (opts.command) args.push(opts.command);
		const { stdout, stderr } = await this.runChecked(opts.socket, args);
		return { paneId: stdout.trim() || null, stderr };
	}

	/** `new-window` — same return contract as splitWindow. */
	async newWindow(opts: {
		target: string;
		/** `-n`: window name. */
		name?: string;
		printPaneId?: boolean;
		cwd?: string;
		command?: string;
	} & SocketOpt): Promise<{ paneId: string | null; stderr: string }> {
		const args = ["new-window"];
		if (opts.name) args.push("-n", opts.name);
		if (opts.printPaneId) args.push("-P", "-F", PANE_ID_FORMAT.formatString);
		args.push("-t", opts.target);
		if (opts.cwd) args.push("-c", opts.cwd);
		if (opts.command) args.push(opts.command);
		const { stdout, stderr } = await this.runChecked(opts.socket, args);
		return { paneId: stdout.trim() || null, stderr };
	}

	/** `kill-pane -t`. */
	killPane(paneId: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["kill-pane", "-t", paneId], opts);
	}

	/**
	 * `capture-pane -p` — pane contents. `escapes` preserves colors/attrs (`-e`);
	 * startLine/endLine map to `-S`/`-E`.
	 */
	async capturePane(opts: {
		target: string;
		escapes?: boolean;
		startLine?: number;
		endLine?: number;
	} & SocketOpt): Promise<string> {
		const args = ["capture-pane", "-p"];
		if (opts.escapes) args.push("-e");
		args.push("-t", opts.target);
		if (opts.startLine !== undefined) args.push("-S", String(opts.startLine));
		if (opts.endLine !== undefined) args.push("-E", String(opts.endLine));
		return (await this.runChecked(opts.socket, args)).stdout;
	}

	// ── Selection, layout, input ───────────────────────────────────────

	/** `select-pane -t` — also sets the pane title when `title` is given (`-T`). */
	selectPane(target: string, opts?: CommandOpts & { title?: string }): Promise<void> {
		const args = ["select-pane", "-t", target];
		if (opts?.title !== undefined) args.push("-T", opts.title);
		return this.runCommand(opts?.socket, args, opts);
	}

	/** `select-window -t`. */
	selectWindow(target: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["select-window", "-t", target], opts);
	}

	/** `select-layout -t <target> <layout>`. */
	selectLayout(target: string, layout: TmuxLayoutName, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["select-layout", "-t", target, layout], opts);
	}

	/** `next-layout -t`. */
	nextLayout(target: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["next-layout", "-t", target], opts);
	}

	/** `resize-pane -Z -t` — toggle zoom on the target's window. */
	toggleZoom(target: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["resize-pane", "-Z", "-t", target], opts);
	}

	/** `send-keys -t <target> <keys…>` — each entry is one tmux key argument. */
	sendKeys(target: string, keys: readonly string[], opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["send-keys", "-t", target, ...keys], opts);
	}

	/** `send-keys -X cancel` — leave copy-mode in the target pane. */
	exitCopyMode(target: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["send-keys", "-t", target, "-X", "cancel"], opts);
	}

	// ── Copy-mode search (terminal ⌘F) ─────────────────────────────────

	/** `copy-mode -t` — enter copy-mode in the target pane (no-op when already in it). */
	enterCopyMode(target: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["copy-mode", "-t", target], opts);
	}

	/**
	 * `send-keys -X history-bottom` — move the copy-mode cursor to the end of
	 * history. Re-anchoring here before every search keeps incremental typing
	 * from drifting the match upward call after call.
	 */
	copyModeHistoryBottom(target: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["send-keys", "-t", target, "-X", "history-bottom"], opts);
	}

	/** `send-keys -X search-backward-text <query>` — literal (non-regex) upward search. */
	copyModeSearchBackwardText(target: string, query: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["send-keys", "-t", target, "-X", "search-backward-text", query], opts);
	}

	/**
	 * `send-keys -X search-again|search-reverse` — step the last search.
	 * "older" repeats it upward; "newer" walks back toward the history bottom.
	 */
	copyModeSearchStep(target: string, direction: "older" | "newer", opts?: CommandOpts): Promise<void> {
		const command = direction === "older" ? "search-again" : "search-reverse";
		return this.runCommand(opts?.socket, ["send-keys", "-t", target, "-X", command], opts);
	}

	// ── Options, hooks, environment, config ────────────────────────────

	/** `set-option -t <target> <option> <value>`. */
	setOption(target: string, option: string, value: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["set-option", "-t", target, option, value], opts);
	}

	/** `set-option -p -t <paneId> <option> <value>` — a pane-scoped (user) option. */
	setPaneOption(paneId: string, option: string, value: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["set-option", "-p", "-t", paneId, option, value], opts);
	}

	/**
	 * `show-options -v -q -t <target> <option>` — the option's value (trimmed), or
	 * "" when unset (`-q` stays quiet on a missing option, `-v` prints value only).
	 */
	async showOption(target: string, option: string, opts?: SocketOpt): Promise<string> {
		const { stdout } = await this.runChecked(opts?.socket, ["show-options", "-v", "-q", "-t", target, option]);
		return stdout.trim();
	}

	/** `set-hook -wt <target> <hook> <command>` — window-scoped hook. */
	setWindowHook(target: string, hook: string, command: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["set-hook", "-wt", target, hook, command], opts);
	}

	/** `set-environment -t <target> <name> <value>` — session environment. */
	setEnvironment(target: string, name: string, value: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["set-environment", "-t", target, name, value], opts);
	}

	/** `set-environment -r -t <target> <name>` — mark a var as removed so a
	 *  stale server-global value stays hidden from new panes/windows. */
	removeEnvironment(target: string, name: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["set-environment", "-r", "-t", target, name], opts);
	}

	/** `source-file <path>` — re-apply a config on a live server. */
	sourceFile(path: string, opts?: CommandOpts): Promise<void> {
		return this.runCommand(opts?.socket, ["source-file", path], opts);
	}
}

/** The app-wide client. All production call sites import THIS. */
export const tmux = new TmuxClient();
