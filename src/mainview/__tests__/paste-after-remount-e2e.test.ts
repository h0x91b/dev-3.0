/**
 * End-to-end test: a paste after the frontend terminal was remounted or reset
 * (h0x91b/dev-3.0#1924).
 *
 * Pipeline under test:
 *   real ghostty-web Terminal → pasteIntoTerminal() → bytes → real PTY → tmux → pane → assert
 *
 * tmux turns DEC 2004 on in its client terminal once, at attach. A task switch, a
 * pane remount or Hard Reset gives the SAME attach a ghostty Terminal whose 2004 is
 * off, and tmux never sends `ESC [?2004h` again — so ghostty alone pastes raw text,
 * which Claude Code splits into an attachment plus typed text past tmux's ~1 KB
 * read chunk. These cases build that exact ghostty state, then check what the pane
 * really receives.
 *
 * Same PTY bridge and FIFO synchronisation as shift-keys-e2e.test.ts. Skipped when
 * tmux or python3 is not on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { init, Terminal } from "ghostty-web";
import {
	spawnSync as cpSpawnSync,
	spawn as cpSpawn,
	type ChildProcess,
} from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTmuxSocketFile } from "../../bun/tmux/socket-files";
import { pasteIntoTerminal } from "../terminal-paste";

const tmuxAvailable = cpSpawnSync("which", ["tmux"], { stdio: "ignore" }).status === 0;
const python3Available = cpSpawnSync("which", ["python3"], { stdio: "ignore" }).status === 0;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Seven lines, ~1.4 KB, non-ASCII included — past tmux's 1 022-byte read chunk. */
const LINES = Array.from(
	{ length: 7 },
	(_, i) => `probe line ${i} — harmless paste — привет ✓ 日本 ${"x".repeat(140)}`,
);
/** What the clipboard path hands over after normalizePastedText(): CR line ends. */
const CLIPBOARD_TEXT = LINES.join("\r");

function isolatedTmuxEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra };
	delete env.TMUX;
	return env;
}

function waitForExit(proc: ChildProcess, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`${label} timed out`));
		}, 4_000);
		proc.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** happy-dom has no canvas; ghostty only needs a context that accepts calls. */
function stubCanvas(): void {
	const metrics = { width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3, fontBoundingBoxAscent: 11, fontBoundingBoxDescent: 3 };
	const context: Record<PropertyKey, unknown> = {};
	const fake = new Proxy(context, {
		get: (target, key) => {
			if (key in target) return target[key];
			if (key === "measureText") return () => metrics;
			if (key === "getImageData" || key === "createImageData") return () => ({ data: new Uint8ClampedArray(4) });
			return () => {};
		},
		set: (target, key, value) => {
			target[key] = value;
			return true;
		},
	});
	(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => fake;
}

interface ProbeTerminal {
	term: Terminal;
	sent: string[];
	write: (data: string) => Promise<void>;
}

function openTerminal(): ProbeTerminal {
	const term = new Terminal({ cols: 80, rows: 24 });
	const host = document.createElement("div");
	document.body.appendChild(host);
	term.open(host);
	const sent: string[] = [];
	term.onData((data) => sent.push(data));
	return {
		term,
		sent,
		write: (data) => new Promise<void>((done) => term.write(data, () => done())),
	};
}

/** A remounted TerminalView: a brand-new Terminal plus the one RIS connectPty sends. */
async function remountedTerminal(): Promise<ProbeTerminal> {
	const probe = openTerminal();
	await probe.write("\x1bc");
	return probe;
}

/** Hard Reset: the Terminal had tmux's 2004 on, then term.reset(). */
async function hardResetTerminal(): Promise<ProbeTerminal> {
	const probe = openTerminal();
	await probe.write("\x1b[?2004h");
	expect(probe.term.hasBracketedPaste()).toBe(true);
	probe.term.reset();
	return probe;
}

describe.skipIf(!tmuxAvailable || !python3Available)(
	"paste after remount/reset e2e (ghostty-web → PTY → tmux → pane)",
	() => {
		let tmpDir: string;
		let tmuxSocket: string;
		const tmuxSession = "paste";
		let bridge: ChildProcess | undefined;
		let bridgeStderr = "";
		let bridgeExitCode: number | null = null;

		const helperScript = (() => {
			const bunMeta = import.meta as unknown as { dir?: string };
			return bunMeta.dir
				? join(bunMeta.dir, "helpers", "pty-tmux-bridge.py")
				: resolve("src/mainview/__tests__/helpers/pty-tmux-bridge.py");
		})();

		beforeAll(async () => {
			await init();
			stubCanvas();
			tmpDir = mkdtempSync(join(tmpdir(), "dev3-paste-e2e-"));
			const tmuxConfigPath = join(tmpDir, "tmux.conf");
			writeFileSync(tmuxConfigPath, "setw -g mouse on\nset -sg escape-time 0\nset -g base-index 1\nsetw -g pane-base-index 1\nset -g remain-on-exit on\n");
			tmuxSocket = `dev3-paste-e2e-${process.pid}`;
			const start = cpSpawnSync(
				"tmux",
				["-L", tmuxSocket, "-f", tmuxConfigPath, "new-session", "-s", tmuxSession, "-d"],
				{ stdio: "pipe", env: isolatedTmuxEnv() },
			);
			if (start.status !== 0) throw new Error(`tmux new-session failed: ${start.stderr?.toString() ?? ""}`);
			bridge = cpSpawn(
				"python3",
				[helperScript, "--", "tmux", "-L", tmuxSocket, "attach-session", "-t", tmuxSession],
				{ stdio: ["pipe", "ignore", "pipe"], env: isolatedTmuxEnv({ TERM: "xterm-256color" }) },
			);
			bridge.stderr?.on("data", (chunk) => { bridgeStderr += chunk.toString(); });
			bridge.once("exit", (code) => { bridgeExitCode = code; });
			await new Promise<void>((done) => setTimeout(done, 1000));
			if (bridge.exitCode !== null) throw new Error(`PTY bridge exited during startup: ${bridgeStderr.trim()}`);
		}, 20_000);

		afterAll(() => {
			cpSpawnSync("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore", env: isolatedTmuxEnv() });
			removeTmuxSocketFile(tmuxSocket);
			bridge?.kill();
			if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
		});

		let runs = 0;

		/**
		 * Respawn the pane as a raw reader of exactly `expectedBytes`, optionally after
		 * enabling DEC 2004 the way Claude Code does, then type `bytes` into the client.
		 */
		async function deliver(bytes: string, paneWantsBrackets: boolean, expectedBytes: number): Promise<string> {
			if (bridgeExitCode !== null) throw new Error(`PTY bridge exited with code ${bridgeExitCode}: ${bridgeStderr.trim()}`);
			const run = ++runs;
			const readyFifo = join(tmpDir, `ready-${run}`);
			const doneFifo = join(tmpDir, `done-${run}`);
			const captureFile = join(tmpDir, `capture-${run}`);
			cpSpawnSync("mkfifo", [readyFifo, doneFifo]);
			const enable = paneWantsBrackets ? "printf '\\033[?2004h' && " : "";
			const innerCmd =
				`stty -icanon -icrnl -inlcr -echo && ${enable}sleep 0.5 && printf R > ${readyFifo} && ` +
				`head -c ${expectedBytes} > ${captureFile} && printf D > ${doneFifo}`;
			const readyProc = cpSpawn("cat", [readyFifo], { stdio: "ignore" });
			const ready = waitForExit(readyProc, "ready FIFO");
			const respawn = cpSpawnSync(
				"tmux",
				["-L", tmuxSocket, "respawn-pane", "-t", `${tmuxSession}:1.1`, "-k", innerCmd],
				{ stdio: "ignore", env: isolatedTmuxEnv() },
			);
			expect(respawn.status, "tmux respawn-pane failed").toBe(0);
			await ready;
			const doneProc = cpSpawn("cat", [doneFifo], { stdio: "ignore" });
			const done = waitForExit(doneProc, "done FIFO");
			bridge!.stdin!.write(bytes, "utf8");
			try {
				await done;
			} catch (error) {
				// head -c buffers, so a short delivery shows up as this timeout, not a diff.
				throw new Error(`${String(error)}: the pane never got ${expectedBytes} bytes — a raw paste is 12 bytes short of a bracketed one`);
			}
			return readFileSync(captureFile, "utf8");
		}

		const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

		it("remount: the new Terminal forgot DEC 2004 (canary for the mechanism)", async () => {
			const { term, sent } = await remountedTerminal();
			expect(term.hasBracketedPaste()).toBe(false);
			term.paste("A\rB");
			expect(sent.join("")).toBe("A\rB");
		});

		it("remount: a multiline >1 KB paste reaches a 2004 pane as ONE bracketed paste", async () => {
			const { term, sent } = await remountedTerminal();
			pasteIntoTerminal(term, CLIPBOARD_TEXT, true);
			const expected = `${PASTE_START}${CLIPBOARD_TEXT}${PASTE_END}`;
			const captured = await deliver(sent.join(""), true, byteLength(expected));
			expect(captured).toBe(expected);
		}, 10_000);

		it("hard reset: a multiline >1 KB paste reaches a 2004 pane as ONE bracketed paste", async () => {
			const { term, sent } = await hardResetTerminal();
			pasteIntoTerminal(term, CLIPBOARD_TEXT, true);
			const expected = `${PASTE_START}${CLIPBOARD_TEXT}${PASTE_END}`;
			const captured = await deliver(sent.join(""), true, byteLength(expected));
			expect(captured).toBe(expected);
		}, 10_000);

		it("an app that never asked for 2004 gets the bare text — tmux strips the markers", async () => {
			const { term, sent } = await remountedTerminal();
			pasteIntoTerminal(term, CLIPBOARD_TEXT, true);
			const captured = await deliver(sent.join(""), false, byteLength(CLIPBOARD_TEXT));
			expect(captured).toBe(CLIPBOARD_TEXT);
			expect(captured).not.toContain("[200~");
		}, 10_000);

		it("imperative LF text and a single Unicode line keep their exact bytes in both modes", async () => {
			for (const text of [LINES.slice(0, 2).join("\n"), "один ✓ 日本 line"]) {
				for (const paneWantsBrackets of [true, false]) {
					const { term, sent } = await remountedTerminal();
					pasteIntoTerminal(term, text, true);
					const expected = paneWantsBrackets ? `${PASTE_START}${text}${PASTE_END}` : text;
					expect(await deliver(sent.join(""), paneWantsBrackets, byteLength(expected))).toBe(expected);
				}
			}
		}, 20_000);

		it("remount restores mouse scrolling without resizing the pane or notifying its app", async () => {
			const tmux = (...args: string[]) => {
				const result = cpSpawnSync("tmux", ["-L", tmuxSocket, ...args], { env: isolatedTmuxEnv(), encoding: "utf8" });
				expect(result.status, result.stderr).toBe(0);
				return result.stdout.trim();
			};
			const winches = join(tmpDir, "scroll-winches");
			const worker = join(tmpDir, "scroll-worker.py");
			writeFileSync(winches, "");
			writeFileSync(worker, [
				"import signal",
				`signal.signal(signal.SIGWINCH, lambda *_: open(${JSON.stringify(winches)}, 'a').write('W'))`,
				"for i in range(200): print('history-line-' + str(i), flush=True)",
				"print('READY-HISTORY-200', flush=True)",
				"while True: signal.pause()",
			].join("\n"));
			tmux("respawn-pane", "-t", `${tmuxSession}:1.1`, "-k", `python3 -u ${worker}`);
			await expect.poll(() => tmux("capture-pane", "-p", "-t", tmuxSession)).toContain("READY-HISTORY-200");
			const geometry = tmux("display-message", "-p", "-t", tmuxSession, "#{pane_width}x#{pane_height}");
			const signalsBefore = readFileSync(winches, "utf8");
			const [clientName, clientPid] = tmux("list-clients", "-t", tmuxSession, "-F", "#{client_name} #{client_pid}").split(" ");
			const { term, write } = await remountedTerminal();
			try {
				let offset = bridgeStderr.length;
				async function consumeOutput() {
					const next = bridgeStderr.length;
					if (next === offset) return;
					await write(bridgeStderr.slice(offset, next));
					offset = next;
				}
				tmux("refresh-client", "-t", clientName);
				await expect.poll(() => bridgeStderr.slice(offset)).toContain("READY-HISTORY-200");
				await consumeOutput();
				expect(term.hasMouseTracking()).toBe(false);

				process.kill(Number(clientPid), "SIGWINCH");
				await expect.poll(() => bridgeStderr.slice(offset)).toMatch(/\x1b\[\?(?:1000|1002|1006)h/);
				await consumeOutput();
				expect(term.hasMouseTracking()).toBe(true);
				expect(tmux("display-message", "-p", "-t", tmuxSession, "#{pane_width}x#{pane_height}")).toBe(geometry);
				expect(readFileSync(winches, "utf8")).toBe(signalsBefore);

				const forwarding = term.onData((data) => bridge!.stdin!.write(data, "utf8"));
				term.attachCustomWheelEventHandler((event) => {
					if (!term.hasMouseTracking()) return false;
					term.input(`\x1b[<${event.deltaY < 0 ? 64 : 65};5;3M`, true);
					return true;
				});
				term.element!.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
				await expect.poll(() => tmux("display-message", "-p", "-t", tmuxSession, "#{pane_in_mode}")).toBe("1");
				term.element!.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
				await expect.poll(() => Number(tmux("display-message", "-p", "-t", tmuxSession, "#{scroll_position}"))).toBeGreaterThan(0);
				tmux("send-keys", "-t", tmuxSession, "-X", "history-top");
				await expect.poll(async () => {
					await consumeOutput();
					const buffer = term.buffer.active;
					return Array.from({ length: term.rows }, (_, row) =>
						buffer.getLine(buffer.length - term.rows + row)!.translateToString(true),
					).join("\n");
				}).toContain("history-line-0");
				forwarding.dispose();
			} finally {
				tmux("send-keys", "-t", tmuxSession, "-X", "cancel");
				term.dispose();
			}
		}, 10_000);

		it("mouse copies preserve the history viewport and cancel restores typing and paste", async () => {
			const tmux = (...args: string[]) => {
				const result = cpSpawnSync("tmux", ["-L", tmuxSocket, ...args], { env: isolatedTmuxEnv(), encoding: "utf8" });
				expect(result.status, result.stderr).toBe(0);
				return result.stdout.trim();
			};
			const bindings = readFileSync(resolve("src/bun/tmux/config.ts"), "utf8").split("\n")
				.filter((line) => /^bind -T copy-mode(?:-vi)? (?:MouseDragEnd|DoubleClick|TripleClick)1Pane /.test(line));
			expect(bindings).toHaveLength(6);
			const config = join(tmpDir, "mouse-copy.conf");
			writeFileSync(config, ["set -s set-clipboard on", ...bindings].join("\n"));
			tmux("source-file", config);
			const capture = join(tmpDir, "input-after-copy");
			const worker = join(tmpDir, "copy-worker.py");
			writeFileSync(capture, "");
			writeFileSync(worker, [
				"import os, tty",
				"print('\\x1b[?2004h', end='')",
				"for i in range(200): print('copy-history-line-' + str(i))",
				"print('READY-COPY-200', flush=True)",
				"tty.setraw(0)",
				"while True:",
				"    data = os.read(0, 4096)",
				`    with open(${JSON.stringify(capture)}, 'ab') as out: out.write(data)`,
			].join("\n"));
			tmux("respawn-pane", "-t", `${tmuxSession}:1.1`, "-k", `python3 -u ${worker}`);
			await expect.poll(() => tmux("capture-pane", "-p", "-t", tmuxSession)).toContain("READY-COPY-200");
			const copiedSince = (offset: number) => {
				const match = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/.exec(bridgeStderr.slice(offset));
				return match ? Buffer.from(match[1], "base64").toString("utf8") : null;
			};
			try {
				let row = 2;
				tmux("set-window-option", "-t", tmuxSession, "mode-keys", "emacs");
				const liveCopyOffset = bridgeStderr.length;
				bridge!.stdin!.write("\x1b[<0;1;2M\x1b[<32;4;2M", "utf8");
				await expect.poll(() => tmux("display-message", "-p", "-t", tmuxSession, "#{pane_in_mode}")).toBe("1");
				bridge!.stdin!.write("\x1b[<32;8;2M\x1b[<0;8;2m", "utf8");
				await expect.poll(() => bridgeStderr.slice(liveCopyOffset)).toMatch(/\x1b\]52;/);
				await expect.poll(() => tmux("display-message", "-p", "-t", tmuxSession, "#{pane_in_mode}")).toBe("0");
				for (const cancel of ["\x1b", "\x03", "q"]) {
					tmux("copy-mode", "-u", "-t", tmuxSession);
					bridge!.stdin!.write(cancel, "utf8");
					await expect.poll(() => tmux("display-message", "-p", "-t", tmuxSession, "#{pane_in_mode}")).toBe("0");
					expect(readFileSync(capture, "utf8")).toBe("");
				}
				tmux("copy-mode", "-u", "-t", tmuxSession);
				const position = tmux("display-message", "-p", "-t", tmuxSession, "#{scroll_position}");
				expect(Number(position)).toBeGreaterThan(0);
				for (const start of [1, 3]) {
					// Separate drag gestures from tmux's double/triple-click detection window.
					await new Promise((resolve) => setTimeout(resolve, 350));
					row += 3;
					const end = start + 7;
					const offset = bridgeStderr.length;
					bridge!.stdin!.write(`\x1b[<0;${start};${row}M\x1b[<32;${end};${row}M\x1b[<0;${end};${row}m`, "utf8");
					await expect.poll(() => copiedSince(offset)).toBe("copy-history-line-".slice(start - 1, end - 1));
					expect(tmux("display-message", "-p", "-t", tmuxSession, "#{pane_in_mode}")).toBe("1");
					expect(tmux("display-message", "-p", "-t", tmuxSession, "#{scroll_position}")).toBe(position);
				}
				// A double-click copies the word and a triple-click the line of that same history
				// row, not of the live screen behind it (capture-pane reads the live screen).
				const liveTop = Number(/copy-history-line-(\d+)/.exec(tmux("capture-pane", "-p", "-t", tmuxSession))![1]);
				for (const clicks of [2, 3]) {
					await new Promise((resolve) => setTimeout(resolve, 350));
					row += 3;
					const line = `copy-history-line-${liveTop - Number(position) + row - 1}`;
					const offset = bridgeStderr.length;
					bridge!.stdin!.write(`\x1b[<0;19;${row}M\x1b[<0;19;${row}m`.repeat(clicks), "utf8");
					// tmux waits out its double-click window, then holds the highlight, before it copies.
					await expect.poll(() => copiedSince(offset)?.trimEnd(), { timeout: 3_000 })
						.toBe(clicks === 2 ? line.slice("copy-history-line-".length) : line);
					expect(tmux("display-message", "-p", "-t", tmuxSession, "#{pane_in_mode}")).toBe("1");
					expect(tmux("display-message", "-p", "-t", tmuxSession, "#{scroll_position}")).toBe(position);
				}
				tmux("send-keys", "-t", tmuxSession, "-X", "cancel");
				expect(tmux("display-message", "-p", "-t", tmuxSession, "#{pane_in_mode}")).toBe("0");
				bridge!.stdin!.write(`typed:${PASTE_START}pasted${PASTE_END}`, "utf8");
				await expect.poll(() => readFileSync(capture, "utf8")).toBe(`typed:${PASTE_START}pasted${PASTE_END}`);
			} finally {
				cpSpawnSync("tmux", ["-L", tmuxSocket, "send-keys", "-t", tmuxSession, "-X", "cancel"], { env: isolatedTmuxEnv() });
			}
		}, 15_000);

		it("an intact Terminal still pastes through ghostty, wrapped exactly once", async () => {
			const { term, sent, write } = openTerminal();
			await write("\x1b[?2004h");
			pasteIntoTerminal(term, "A\rB", true);
			expect(sent).toEqual([`${PASTE_START}A\rB${PASTE_END}`]);
		});

		it("a native stream keeps ghostty's own decision — no brackets the app did not ask for", async () => {
			const { term, sent } = await remountedTerminal();
			pasteIntoTerminal(term, "A\rB", false);
			expect(sent).toEqual(["A\rB"]);
		});
	},
);
