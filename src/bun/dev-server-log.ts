/**
 * Writing and reading the dev server's log file.
 *
 * Two processes write through this: the tiny CLI sink `tmux pipe-pane` feeds on
 * the tmux backend, and the native session host in its PTY callback. Neither is
 * the app, so nothing here talks to the board, the socket, or a logger — it is
 * `node:fs` and the pure filter next door.
 *
 * Failure policy: a log is a convenience, the dev server is the product. Every
 * write is best-effort and swallows its error, because an unwritable log must
 * never take down the pane it is watching.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	DEV_SERVER_LOG_KEEP_BYTES,
	DEV_SERVER_LOG_MAX_BYTES,
	DevServerLogFilter,
	tailLines,
	trimLogContent,
} from "../shared/dev-server-log";

/** How long a partial line may sit unwritten before the writer flushes it anyway. */
const IDLE_FLUSH_MS = 1000;

/**
 * Create the directory and drop what the previous run left. Called by the app at
 * start, before anything is capturing — one run's log is that run's output, and
 * an appended-to file would make an old error look like a current one.
 */
export function resetDevServerLog(path: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		rmSync(path, { force: true });
	} catch {
		// An unwritable log directory is not a reason to refuse to start a server.
	}
}

/**
 * Terminal bytes in, a capped plain-text file out.
 *
 * The idle flush is what makes a dev server's last line readable: a server that
 * printed a prompt and went quiet holds that line in the filter forever
 * otherwise, and "the log ends one line before the interesting one" is exactly
 * the failure an agent cannot diagnose.
 */
export interface DevServerLogWriterOptions {
	/** Size at which the file is trimmed. Injectable so a test can prove trimming without writing 32 MB. */
	maxBytes?: number;
	/** What a trim keeps. */
	keepBytes?: number;
}

export class DevServerLogWriter {
	private readonly filter = new DevServerLogFilter();
	private readonly decoder = new TextDecoder("utf8");
	private readonly maxBytes: number;
	private readonly keepBytes: number;
	private idle: ReturnType<typeof setTimeout> | null = null;
	private dirReady = false;
	private closed = false;

	constructor(private readonly path: string, opts: DevServerLogWriterOptions = {}) {
		this.maxBytes = opts.maxBytes ?? DEV_SERVER_LOG_MAX_BYTES;
		this.keepBytes = opts.keepBytes ?? DEV_SERVER_LOG_KEEP_BYTES;
	}

	write(chunk: Uint8Array | string): void {
		if (this.closed) return;
		const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		this.append(this.filter.push(text));
		this.scheduleIdleFlush();
	}

	/** Write the held-back partial line and stop. Safe to call twice. */
	close(): void {
		if (this.closed) return;
		this.clearIdle();
		this.append(this.filter.flush());
		this.closed = true;
	}

	private scheduleIdleFlush(): void {
		this.clearIdle();
		this.idle = setTimeout(() => {
			this.idle = null;
			this.append(this.filter.flush());
		}, IDLE_FLUSH_MS);
		// A pending flush must never hold a process open on its own.
		this.idle?.unref?.();
	}

	private clearIdle(): void {
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
	}

	private append(text: string): void {
		if (!text) return;
		try {
			// The app clears the file before it starts a server, but the host is a
			// separate process that may outlive that directory's creation — make it
			// here too rather than lose the output to an ENOENT nobody sees.
			if (!this.dirReady) {
				mkdirSync(dirname(this.path), { recursive: true });
				this.dirReady = true;
			}
			appendFileSync(this.path, text, "utf8");
			this.trimIfOversized();
		} catch {
			// Best-effort: see the file note.
		}
	}

	/**
	 * Keep the tail in place rather than rotating: `AGENTS.md` forbids renaming
	 * anything under `~/.dev3.0/`, and a second file would only be half an answer
	 * to "where do I grep".
	 */
	private trimIfOversized(): void {
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch {
			return;
		}
		if (size <= this.maxBytes) return;
		try {
			const content = readFileSync(this.path, "utf8");
			writeFileSync(this.path, trimLogContent(content, this.keepBytes), "utf8");
		} catch {
			// Leave the oversized file alone rather than lose it to a failed rewrite.
		}
	}
}

export interface DevServerLogTail {
	/** False when nothing has been captured yet — a dev server that never ran, or a backend that cannot capture. */
	exists: boolean;
	/** The requested number of lines, newest last. Empty when the file is empty. */
	text: string;
	/** Bytes on disk, so a caller can say "there is more than you asked for". */
	bytes: number;
}

export function readDevServerLogTail(path: string, lines: number): DevServerLogTail {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return { exists: false, text: "", bytes: 0 };
	}
	return { exists: true, text: tailLines(content, lines), bytes: Buffer.byteLength(content, "utf8") };
}
