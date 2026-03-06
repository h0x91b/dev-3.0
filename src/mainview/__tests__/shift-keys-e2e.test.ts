/**
 * End-to-end test: Shift+key sequences through the full terminal input pipeline.
 *
 * Pipeline under test:
 *   ghostty-web WASM handler  →  bytes  →  real PTY  →  tmux  →  inner pane  →  assert
 *
 * Why a real PTY (not tmux send-keys):
 *   tmux send-keys injects key names into a pane, bypassing the terminal input
 *   parser.  That parser is what silently dropped our CSI u encoding in production.
 *   Writing bytes to a PTY master exercises the exact same path as production.
 *
 * Synchronisation: two named FIFOs (no sleep, no polling in the test loop).
 *   ready  — inner process signals "I am in raw mode, head -c is about to start"
 *   done   — inner process signals "head -c captured exactly N bytes"
 *
 * Skipped automatically when tmux or python3 is not on PATH.
 *
 * Uses node:child_process (not Bun.spawn) so the module loads correctly in
 * vitest's happy-dom environment, which does not expose the Bun global.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InputHandler, Ghostty } from "ghostty-web";
import { SHIFT_KEY_SEQUENCES, getShiftKeySequence } from "../shift-key-sequences";
import {
	spawnSync as cpSpawnSync,
	spawn as cpSpawn,
	type ChildProcess,
} from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── Production tmux config ────────────────────────────────────────────────────
// Copied from src/bun/pty-server.ts (TMUX_CONFIG constant).
// The test must use the identical config so we catch regressions that only
// manifest with the real settings (e.g. escape-time 0, mouse on).
// If you change pty-server.ts, keep this in sync.
const TMUX_CONFIG_FOR_TEST = `# Mouse support
setw -g mouse on

# Window/pane numbering starts at 1
set -g base-index 1
setw -g pane-base-index 1

# 256-color terminal
set -g default-terminal "tmux-256color"

# Scrollback buffer
set -g history-limit 50000

# No escape delay (for vim/neovim)
set -sg escape-time 0

# Auto-rename windows by running command
setw -g automatic-rename on

# Renumber windows when one is closed
set -g renumber-windows on

# Intuitive splits (open in same directory)
bind | split-window -h -c "#{pane_current_path}"
bind \\\\ split-window -h -c "#{pane_current_path}"
bind - split-window -v -c "#{pane_current_path}"

# Alt+arrow pane switching (no prefix required)
bind -n M-Left select-pane -L
bind -n M-Right select-pane -R
bind -n M-Up select-pane -U
bind -n M-Down select-pane -D

# Status bar
set -g status-right "#(ps -t #{pane_tty} -o pid=,comm= --sort=-start_time | head -1) | #{pane_current_path} | #(cd #{pane_current_path}; git branch --show-current 2>/dev/null || echo '-') | ^b+| split ^b+- hsplit ^b+z zoom"
set -g status-right-length 150

# Clipboard support
set -s set-clipboard on
bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"
bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"

# Bell pass-through
set -g visual-bell off
set -g bell-action any
setw -g monitor-bell on

# Keep panes alive after their command exits (required for test session stability)
set -g remain-on-exit on

`;

// ── Availability check (runs at module load time / test-collection time) ──────
const tmuxAvailable =
	cpSpawnSync("which", ["tmux"], { stdio: "ignore" }).status === 0;
const python3Available =
	cpSpawnSync("which", ["python3"], { stdio: "ignore" }).status === 0;

// ── Shared test helpers ───────────────────────────────────────────────────────
// Mirrors the helpers in shift-keys.test.ts so the e2e suite is self-contained.

const SHIFT = 1;

function keyEvent(code: string, key: string, mods = 0): KeyboardEvent {
	return {
		type: "keydown",
		code,
		key,
		shiftKey: !!(mods & SHIFT),
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		keyCode: 0,
		isComposing: false,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as KeyboardEvent;
}

function makeContainer() {
	const listeners: Record<string, Function> = {};
	return {
		obj: {
			hasAttribute: () => false,
			setAttribute: () => {},
			style: {},
			addEventListener: (type: string, fn: Function) => {
				listeners[type] = fn;
			},
			removeEventListener: () => {},
		},
		fire(event: KeyboardEvent) {
			listeners.keydown?.(event);
		},
	};
}

function makeCustomHandler(sent: string[]) {
	return (event: KeyboardEvent): boolean => {
		const seq = getShiftKeySequence(event);
		if (seq) {
			sent.push(seq);
			return true;
		}
		return false;
	};
}

/** Wrap child_process.spawn exit in a Promise. */
function waitForExit(proc: ChildProcess): Promise<void> {
	return new Promise<void>((resolve) => {
		proc.on("exit", () => resolve());
	});
}

// ── E2E suite ─────────────────────────────────────────────────────────────────
describe.skipIf(!tmuxAvailable || !python3Available)(
	"Shift+key e2e (ghostty-web → PTY → tmux → inner pane)",
	() => {
		let ghostty: InstanceType<typeof Ghostty>;
		let tmpDir: string;
		let readyFifo: string;
		let doneFifo: string;
		let captureFile: string;
		let tmuxSocket: string;
		let tmuxSession: string;
		let pythonProc: ChildProcess | undefined;

		// import.meta.url is http://localhost/... in happy-dom (browser simulation),
		// so new URL(..., import.meta.url) gives the wrong path.
		// Use import.meta.dir (Bun-specific, gives the real filesystem directory of this
		// file) if available, or fall back to a project-root-relative resolve().
		const helperScript = (() => {
			const bunMeta = import.meta as unknown as { dir?: string };
			return bunMeta.dir
				? join(bunMeta.dir, "helpers", "pty-tmux-bridge.py")
				: resolve("src/mainview/__tests__/helpers/pty-tmux-bridge.py");
		})();

		beforeAll(async () => {
			// Load ghostty WASM (same as shift-keys.test.ts)
			ghostty = await Ghostty.load();

			// Temp directory for FIFOs and capture file
			tmpDir = mkdtempSync(join(tmpdir(), "dev3-e2e-"));
			readyFifo = join(tmpDir, "ready");
			doneFifo = join(tmpDir, "done");
			captureFile = join(tmpDir, "capture");
			cpSpawnSync("mkfifo", [readyFifo, doneFifo]);

			// Write the production tmux config to a temp file
			const tmuxConfigPath = join(tmpDir, "tmux.conf");
			writeFileSync(tmuxConfigPath, TMUX_CONFIG_FOR_TEST);

			// Start tmux server synchronously in detached mode (no PTY needed).
			// Unique socket name isolates this from the user's personal tmux server.
			tmuxSocket = `dev3-e2e-${process.pid}`;
			tmuxSession = "e2e";
			const startResult = cpSpawnSync(
				"tmux",
				["-L", tmuxSocket, "-f", tmuxConfigPath, "new-session", "-s", tmuxSession, "-d"],
				{ stdio: "pipe" },
			);
			if (startResult.status !== 0) {
				const stderr = startResult.stderr?.toString() ?? "";
				throw new Error(`tmux new-session failed: ${stderr}`);
			}

			// Now attach a PTY-backed client via the Python helper.
			// Bytes written to the helper's stdin travel:
			//   test → helper stdin → PTY master → tmux (input parser) → inner pane
			pythonProc = cpSpawn(
				"python3",
				[
					helperScript, "--",
					"tmux", "-L", tmuxSocket, "attach-session", "-t", tmuxSession,
				],
				{
					stdio: ["pipe", "ignore", "ignore"],
					// Ensure TERM is set: tmux attach-session exits immediately if
					// it cannot determine the terminal type (e.g. in CI environments).
					env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
				},
			);

			// Give the attach-session client time to complete its handshake with
			// tmux and set up the PTY in raw mode before tests start sending bytes.
			// 1000ms is conservative but necessary on loaded CI machines where
			// the default 500ms can leave the bridge not yet connected.
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		}, 20_000);

		afterAll(() => {
			cpSpawnSync("tmux", ["-L", tmuxSocket, "kill-server"], {
				stdio: "ignore",
			});
			pythonProc?.kill();
			if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
		});

		// ── Ghostty-web byte generators ───────────────────────────────────────

		/** Fire a Shift+code event through the InputHandler. Pass withFix=true to enable our custom handler. */
		function getBytes(code: string, withFix: boolean): string {
			const sent: string[] = [];
			const container = makeContainer();
			new InputHandler(
				ghostty,
				container.obj as never,
				(data: string) => sent.push(data),
				() => {},
				null as never,
				withFix ? makeCustomHandler(sent) : (null as never),
				null as never,
			);
			container.fire(keyEvent(code, code, SHIFT));
			return sent.join("");
		}

		// ── Core pipeline runner ──────────────────────────────────────────────

		/**
		 * Send `bytes` through the real PTY → tmux pipeline and return what
		 * the inner pane captured.
		 *
		 * Synchronisation uses two named FIFOs (no sleep or polling in the loop):
		 *   - readyFifo: inner process signals "head -c N is about to start"
		 *   - doneFifo:  inner process signals "head -c N finished"
		 *
		 * The inner command (run via tmux respawn-pane -k):
		 *   stty -icanon -icrnl -echo && sleep 0.2 && printf R > ready && head -c N > capture && printf D > done
		 *
		 * stty -icanon -icrnl -echo prevents the line discipline from transforming bytes:
		 *   -icanon disables canonical (line-buffered) mode so bytes arrive immediately
		 *   -icrnl  disables CR→NL translation so \r is not silently converted to \n
		 *   -echo   suppresses the echo of input bytes back to the PTY master
		 * (We avoid `stty raw` because it fails with exit code 1 in the Python PTY context.)
		 * The 0.2 s sleep
		 * drains tmux initialization bytes sent to new panes before capture starts.
		 */
		async function runPipelineTest(bytes: string): Promise<string> {
			const N = Buffer.byteLength(bytes, "utf8");
			const innerCmd =
				`stty -icanon -icrnl -echo && sleep 0.2 && printf R > ${readyFifo} && ` +
				`head -c ${N} > ${captureFile} && printf D > ${doneFifo}`;

			// Start the ready-FIFO reader BEFORE respawning the pane.
			// POSIX: opening a FIFO in O_RDONLY blocks until a writer arrives, so
			// `cat` will block here until the inner process writes its ready signal.
			const readyProc = cpSpawn("cat", [readyFifo], { stdio: "ignore" });
			const readyDone = waitForExit(readyProc);

			// Kill the current pane and start the inner command fresh.
			const r = cpSpawnSync(
				"tmux",
				["-L", tmuxSocket, "respawn-pane", "-t", `${tmuxSession}:1.1`, "-k", innerCmd],
				{ stdio: "ignore" },
			);
			expect(r.status, "tmux respawn-pane failed").toBe(0);

			// Wait until the inner process has entered raw mode and head is ready.
			await readyDone;

			// Start the done-FIFO reader BEFORE sending bytes.
			// printf D > doneFifo blocks until this reader opens the FIFO for reading.
			const doneProc = cpSpawn("cat", [doneFifo], { stdio: "ignore" });
			const doneDone = waitForExit(doneProc);

			// Write bytes to the Python helper's stdin → PTY master → tmux → pane.
			pythonProc!.stdin!.write(bytes, "utf8");

			// Wait until head -c N captured all bytes and wrote the done signal.
			await doneDone;

			return readFileSync(captureFile, "utf8");
		}

		// ── Tests: all Shift+key combinations (our handler active) ───────────

		for (const [code, expectedSeq] of Object.entries(SHIFT_KEY_SEQUENCES)) {
			it(
				`Shift+${code} passes through tmux unchanged`,
				async () => {
					const bytes = getBytes(code, true);
					// Sanity-check: our handler produced the expected sequence.
					expect(bytes).toBe(expectedSeq);

					const captured = await runPipelineTest(bytes);
					expect(captured).toBe(bytes);
				},
				5_000,
			);
		}

		// ── Specific byte-level assertions ────────────────────────────────────

		it(
			"Shift+Enter: 0x0a (LF) arrives as LF, not CR (0x0d)",
			async () => {
				const bytes = getBytes("Enter", true);
				expect(bytes.charCodeAt(0)).toBe(0x0a); // must be LF

				const captured = await runPipelineTest(bytes);
				expect(captured.charCodeAt(0)).toBe(0x0a);
			},
			5_000,
		);

		// ── Canary tests: ghostty-web bug survives the full pipeline ──────────
		//
		// These tests use the bare InputHandler WITHOUT our custom fix.
		// They document that the bug manifests end-to-end, not just in unit tests.
		// If ghostty-web fixes the bug upstream, these assertions will fail —
		// which is exactly the signal we want (the workaround can then be removed).

		it(
			"CANARY: without fix, Shift+Tab goes through tmux as plain \\t",
			async () => {
				const bytes = getBytes("Tab", false);
				expect(bytes).toBe("\t"); // confirms the ghostty-web bug is present

				const captured = await runPipelineTest(bytes);
				expect(captured).toBe("\t"); // tmux passes it through unchanged
			},
			5_000,
		);

		it(
			"CANARY: without fix, Shift+Enter goes through tmux as plain \\r",
			async () => {
				const bytes = getBytes("Enter", false);
				expect(bytes).toBe("\r"); // confirms the ghostty-web bug is present

				const captured = await runPipelineTest(bytes);
				expect(captured).toBe("\r"); // tmux passes it through unchanged
			},
			5_000,
		);
	},
);
