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
