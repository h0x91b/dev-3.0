/**
 * The dev server's output, as plain text an agent can grep.
 *
 * A dev server's output lives in a terminal pane and nowhere else: tmux keeps it
 * in the server's memory (`history-limit`), a native pane keeps a 256 KB base64
 * journal, and both die with the session. Reading it means attaching to a pane —
 * which an agent cannot grep, tail, or diff. So the pane's bytes are ALSO written
 * to one file next to the task's worktree.
 *
 * What this file owns: where that file lives, and how terminal bytes become text.
 * The capture points themselves are per backend (tmux `pipe-pane`, the native
 * host's PTY callback) and live next to each backend.
 *
 * ONE file per server, never rotated. `AGENTS.md` forbids renaming anything under
 * `~/.dev3.0/`, so a `.1`/`.prev` rotation is out; the writer trims the file in
 * place instead, and each dev-server start truncates what the previous run left.
 */

import { DEFAULT_DEV_SERVER_NAME } from "./dev-servers";

/** Hard ceiling for one run's log. Past it the writer keeps {@link DEV_SERVER_LOG_KEEP_BYTES}. */
export const DEV_SERVER_LOG_MAX_BYTES = 32 * 1024 * 1024;

/** What survives a trim — the tail, because a dev server's newest output is the interesting one. */
export const DEV_SERVER_LOG_KEEP_BYTES = 8 * 1024 * 1024;

/** The line the writer leaves where it dropped the head of the file. */
export const DEV_SERVER_LOG_TRIM_NOTICE = "[dev3] earlier output dropped (log exceeded its size cap)";

/** Default tail length for `dev3 dev-server logs`. */
export const DEV_SERVER_LOG_DEFAULT_LINES = 200;

/** Upper bound for `--lines`, so one command cannot paste a 32 MB log into an agent's context. */
export const DEV_SERVER_LOG_MAX_LINES = 5000;

/**
 * The internal CLI verb `tmux pipe-pane` feeds the dev pane's bytes to. Hidden
 * from `--help` like `__pane-run`: it is dev3 talking to itself, and running it
 * by hand would only sit there reading a terminal nobody is writing to.
 */
export const DEV_SERVER_LOG_SINK_VERB = "__dev-server-log";

/**
 * How a native session host is told to mirror its PTY output to a file. The host
 * is a detached process configured entirely through its environment, so this is
 * the only channel that reaches it — empty means "no plain-text log", which is
 * every ordinary shell pane.
 */
export const NATIVE_SESSION_OUTPUT_LOG_ENV = "DEV3_NATIVE_SESSION_OUTPUT_LOG";

/**
 * Sibling of the git worktree, never inside it: a log under `<worktree>/` would
 * show up untracked in `git status` and in the diff the user reviews. Same
 * placement rule as the spilled agent messages next door.
 *
 * One file per dev server, because a task runs one per declared name. The
 * default server keeps the historical filename — another installed version of
 * dev3 reads that exact path.
 */
export function devServerLogPath(taskRoot: string, serverName?: string): string {
	const suffix = !serverName || serverName === DEFAULT_DEV_SERVER_NAME ? "" : `-${serverName}`;
	return `${taskRoot}/logs/dev-server${suffix}.log`;
}

const ESC = "\u001b";
const CSI_PATTERN = "\\u001b\\[[0-?]*[ -/]*[@-~]";
const SINGLE_ESCAPE_PATTERN = "\\u001b[@-Z\\\\-_]";
/** Charset designation (`ESC ( B` and friends) — two bytes, no CSI, and left behind by every shell prompt. */
const CHARSET_PATTERN = "\\u001b[()*+#%][0-9A-Za-z]";
const OSC_PATTERN = "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)";

const CSI = new RegExp(CSI_PATTERN, "g");
const SINGLE_ESCAPE = new RegExp(SINGLE_ESCAPE_PATTERN, "g");
const OSC = new RegExp(OSC_PATTERN, "g");
const CHARSET = new RegExp(CHARSET_PATTERN, "g");
const FINISHED_AT_START = new RegExp(`^(?:${CSI_PATTERN}|${CHARSET_PATTERN}|${SINGLE_ESCAPE_PATTERN}|${OSC_PATTERN})`);
/** Everything unprintable except tab and newline — a log is text, not a terminal. */
const OTHER_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * True when `text` ends mid-escape, so the writer holds it back instead of letting
 * a sequence split across two PTY chunks leak half its bytes into the log.
 */
function endsMidEscape(text: string): boolean {
	const esc = text.lastIndexOf(ESC);
	if (esc < 0) return false;
	return !FINISHED_AT_START.test(text.slice(esc));
}

/**
 * One rendered line out of one terminal line: a carriage return rewrites the line
 * from its start, which is how progress bars and spinners work. Keeping only what
 * survives the last `\r` turns 4 000 redraws of one line back into one line.
 */
function collapseCarriageReturns(line: string): string {
	const parts = line.split("\r");
	return parts[parts.length - 1] ?? "";
}

/**
 * Terminal bytes in, greppable text out.
 *
 * Stateful on purpose: a PTY hands over arbitrary chunks, so escape sequences and
 * lines both straddle them. Complete lines are emitted as they finish; a partial
 * tail is held until it completes or {@link DevServerLogFilter.flush} is called.
 */
export class DevServerLogFilter {
	private pending = "";

	/** Feed one chunk; returns the complete lines it finished (often empty). */
	push(chunk: string): string {
		this.pending += chunk;
		const lastNewline = this.pending.lastIndexOf("\n");
		if (lastNewline < 0) return "";
		const ready = this.pending.slice(0, lastNewline + 1);
		this.pending = this.pending.slice(lastNewline + 1);
		return this.render(ready);
	}

	/** Emit whatever is still held back — the run ended, or the pane went quiet. */
	flush(): string {
		if (!this.pending || endsMidEscape(this.pending)) return "";
		const rest = this.pending;
		this.pending = "";
		const rendered = this.render(rest);
		return rendered ? `${rendered}\n` : "";
	}

	private render(text: string): string {
		const stripped = text
			.replace(OSC, "")
			.replace(CSI, "")
			.replace(CHARSET, "")
			.replace(SINGLE_ESCAPE, "")
			.replace(/\r\n/g, "\n");
		const lines = stripped.split("\n");
		const endedWithNewline = lines[lines.length - 1] === "";
		if (endedWithNewline) lines.pop();
		const rendered = lines
			.map((line) => collapseCarriageReturns(line).replace(OTHER_CONTROLS, "").trimEnd())
			.join("\n");
		return endedWithNewline ? `${rendered}\n` : rendered;
	}
}

/** The last `count` lines of `text`, newest last. */
export function tailLines(text: string, count: number): string {
	if (count <= 0) return "";
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.slice(-count).join("\n");
}

/**
 * What a trimmed log looks like: the notice, then the tail starting at a line
 * boundary, so no half line survives the cut.
 */
export function trimLogContent(content: string, keepBytes: number): string {
	if (Buffer.byteLength(content, "utf8") <= keepBytes) return content;
	const buf = Buffer.from(content, "utf8");
	const cut = buf.subarray(buf.length - keepBytes).toString("utf8");
	const firstNewline = cut.indexOf("\n");
	const aligned = firstNewline < 0 ? cut : cut.slice(firstNewline + 1);
	return `${DEV_SERVER_LOG_TRIM_NOTICE}\n${aligned}`;
}
