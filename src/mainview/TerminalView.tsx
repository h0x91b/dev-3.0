import { useEffect, useRef, useState } from "react";
import { Terminal, FitAddon } from "ghostty-web";
import { useT } from "./i18n";
import { toast } from "./toast";
import { api, isElectrobun } from "./rpc";
import { getShiftKeySequence } from "./shift-key-sequences";
import { encodeResizeSequence } from "../shared/resize-protocol";
import {
	claimMessage,
	decodeNativeStreamMessage,
	ptyUrlWithSince,
	type NativeStreamHeader,
	type NativeStreamRole,
	type NativeViewerStatus,
} from "../shared/native-terminal-stream";
// TEMP DIAGNOSTIC: remove these imports after the terminal copy bug is fixed.
import type { TerminalCopyDiagnostics } from "./terminal-copy-diagnostics";
import { installTerminalCopyDiagnostics } from "./terminal-copy-diagnostics";
import { getEffectiveZoom, ZOOM_CHANGED_EVENT } from "./zoom";
import {
	getTerminalBidiEnabled,
	TERMINAL_BIDI_CHANGED_EVENT,
} from "./terminal-bidi/flag";
import { installBidiRender, uninstallBidiRender } from "./terminal-bidi/proxy";
import { installCursorVisibilityGate, type CursorVisibilityGate } from "./terminal-cursor-focus";
import { installGlyphCellFit, type GlyphCellFit } from "./terminal-glyph-cell-fit";
import { getScrollThreshold } from "./scroll-speed";
import { createWheelPacer } from "./wheel-pacer";
import type { TaskPaneAction } from "../shared/task-panes";
import { matchesShortcut } from "./keymap";
import { uploadDroppedFile } from "./utils/uploadDroppedFile";
import { writeClipboardText } from "./utils/clipboard-write";
import { isLargeTextPaste, uploadPastedText } from "./utils/uploadPastedText";
import { imageFilesFromClipboard } from "./utils/clipboardImageFiles";
import { createAnsiThemeFilter } from "./utils/ansi-theme-adapt";
import { submitPastedText } from "./terminal-submit";
import { createFilePathLinkProvider, type FilePathLinkProvider } from "./terminal-file-links";
import { installFilePathUnderlines, type FilePathUnderlinesHandle } from "./terminal-link-underlines";
import { activateTerminalPath } from "./terminal-path-open";
import { isRemote } from "./utils/platform";
import { paneHighlightRect, type PaneRectPct } from "./utils/paneHighlight";
import TerminalSearchBar, { type TerminalSearchBarHandle } from "./components/TerminalSearchBar";
import { isFinalPtyCloseCode } from "../shared/pty-ws-close-codes";

const DARK_TERMINAL_THEME = {
	background: "#1a1b26",
	foreground: "#a9b1d6",
	cursor: "#c0caf5",
	selectionBackground: "#33467c",
	black: "#15161e",
	red: "#f7768e",
	green: "#9ece6a",
	yellow: "#e0af68",
	blue: "#7aa2f7",
	magenta: "#bb9af7",
	cyan: "#7dcfff",
	white: "#a9b1d6",
	brightBlack: "#414868",
	brightRed: "#f7768e",
	brightGreen: "#9ece6a",
	brightYellow: "#e0af68",
	brightBlue: "#7aa2f7",
	brightMagenta: "#bb9af7",
	brightCyan: "#7dcfff",
	brightWhite: "#c0caf5",
};

const LIGHT_TERMINAL_THEME = {
	background: "#ffffff",
	foreground: "#24292f",
	cursor: "#24292f",
	selectionBackground: "#0366d625",
	black: "#24292e",
	red: "#d73a49",
	green: "#28a745",
	yellow: "#9a6700",
	blue: "#005cc5",
	magenta: "#5a32a3",
	cyan: "#0598bc",
	white: "#57606a",
	brightBlack: "#6e7781",
	brightRed: "#cb2431",
	brightGreen: "#22863a",
	brightYellow: "#b08800",
	brightBlue: "#0366d6",
	brightMagenta: "#6f42c1",
	brightCyan: "#3192aa",
	brightWhite: "#d1d5da",
};

const TERMINAL_BASE_FONT_SIZE = 14;
/**
 * A terminal teardown longer than this blocked the renderer for that long: every
 * dispose on the path is synchronous. One frame at 60 Hz is 16 ms, so 50 ms is
 * already three dropped frames — worth a line, while staying quiet in normal use.
 */
const TERMINAL_DISPOSE_BUDGET_MS = 50;

/**
 * How long the sync gate waits for the first repaint before lifting itself.
 * A session that emits nothing after attach (idle shell, refused socket) must
 * not stay blurred forever, so the gate is a hint with a deadline — not a lock.
 */
export const TERMINAL_SYNC_GATE_TIMEOUT_MS = 2_500;

// ghostty-web 0.4.0 FitAddon reserves 15px on width for a native scrollbar
// that never appears — ghostty draws its scrollbar overlaid on the canvas.
// The reservation eats ~2 columns of usable terminal width. This drop-in
// replacement mirrors the upstream logic minus that subtraction.
function proposeDimensionsWithoutScrollbarReserve(
	this: FitAddon,
): { cols: number; rows: number } | undefined {
	const self = this as unknown as {
		_terminal?: {
			element?: HTMLElement;
			renderer?: { getMetrics: () => { width: number; height: number } | null };
		};
	};
	const terminal = self._terminal;
	const renderer = terminal?.renderer;
	const element = terminal?.element;
	if (!terminal || !renderer || !element || typeof renderer.getMetrics !== "function") return undefined;
	const metrics = renderer.getMetrics();
	if (!metrics || metrics.width === 0 || metrics.height === 0) return undefined;
	const cw = element.clientWidth;
	const ch = element.clientHeight;
	if (cw === 0 || ch === 0) return undefined;
	const styles = window.getComputedStyle(element);
	const padTop = parseInt(styles.getPropertyValue("padding-top"), 10) || 0;
	const padBot = parseInt(styles.getPropertyValue("padding-bottom"), 10) || 0;
	const padLeft = parseInt(styles.getPropertyValue("padding-left"), 10) || 0;
	const padRight = parseInt(styles.getPropertyValue("padding-right"), 10) || 0;
	const availW = cw - padLeft - padRight;
	const availH = ch - padTop - padBot;
	const cols = Math.max(2, Math.floor(availW / metrics.width));
	const rows = Math.max(1, Math.floor(availH / metrics.height));
	return { cols, rows };
}

/**
 * Build the two-stage resize-dance WebSocket messages that force tmux to
 * redraw on reconnect — including the same-size reconnect case where the
 * kernel would otherwise skip SIGWINCH.
 *
 * The nudge always targets **rows** (never columns) so the two paints
 * share column width and therefore produce identical text wrapping. A
 * column nudge makes every line re-wrap at a slightly narrower width and
 * then at the target width, which is visible as a "refresh / realign"
 * flicker on every task switch. See decision 041.
 *
 * Exported for unit testing — keeps the nudge axis pinned against
 * accidental refactors.
 */
export function buildResizeDance(cols: number, rows: number): [string, string] {
	const nudgeRows = rows + 1;
	return [
		encodeResizeSequence(cols, nudgeRows),
		encodeResizeSequence(cols, rows),
	];
}

/**
 * iTerm2-style Alt/Option-click cursor move. Given the current readline cursor
 * cell and the clicked cell (both 1-indexed, viewport-relative), return the
 * plain CSI arrow sequence that walks the cursor horizontally to the target.
 *
 * v1 is horizontal-only and confined to the cursor's own row:
 * - A cross-row click returns "" (no-op). In a shell, Up/Down map to command
 *   history, not cursor motion, and a different row usually means a different
 *   tmux pane, scrollback, or a wrapped/multi-line buffer we cannot resolve
 *   unambiguously — so we deliberately do nothing.
 * - A zero horizontal delta returns "".
 *
 * Otherwise it emits |Δcol| of \x1b[C (right) or \x1b[D (left). Plain arrows
 * (no Alt modifier) are emitted on purpose so the sequence never collides with
 * tmux's `bind -n M-Left/Right` pane-switch bindings (which are Alt+Arrow).
 *
 * Exported for unit testing — keeps the delta→sequence mapping pinned.
 */
export function buildCursorMoveSequence(
	fromCol: number,
	fromRow: number,
	toCol: number,
	toRow: number,
): string {
	if (fromRow !== toRow) return "";
	const dCol = toCol - fromCol;
	if (dCol === 0) return "";
	return (dCol > 0 ? "\x1b[C" : "\x1b[D").repeat(Math.abs(dCol));
}

// Normalize pasted line endings to lone CR, matching xterm.js. A real Enter is
// CR (\r), so a paste carrying CRLF (Windows) or LF (Unix) must collapse to CR;
// otherwise the stray bytes read as extra line breaks (or, on the raw paste
// path, as a submit after the first line). Exported for unit testing.
export function normalizePastedText(text: string): string {
	return text.replace(/\r\n|\r|\n/g, "\r");
}

// ghostty-web 0.4.0 never invalidates the selection when the terminal content
// changes. A selection goes stale whenever the app OWNS THE SCREEN and repaints
// cells in place instead of scrolling the buffer — the highlight is anchored to
// a viewport row whose text is rewritten under it, leaving a stale overlay over
// the wrong characters. Two cases:
//   • Alternate screen (vim, htop, less): no scrollback, repaint in place.
//   • Primary screen WITH mouse tracking (Claude Code and other inline TUIs):
//     they render on the primary buffer (isAlternateScreen()===false) with SGR
//     mouse mode on, and repaint the same rows on every keystroke/scroll while
//     viewportY stays put. Confirmed via runtime logs: alt:false, mouseTracking:
//     true, viewportY:0, selStartY frozen across repaints (decision 077 update).
// Clear the selection on a write in either case. A plain primary-screen
// scrollback selection (no mouse tracking) is left untouched — it is anchored to
// an absolute buffer row and correctly scrolls away with its text.
export function clearStaleSelectionOnWrite(term: {
	isAlternateScreen?: () => boolean;
	hasMouseTracking?: () => boolean;
	hasSelection?: () => boolean;
	clearSelection?: () => void;
}): void {
	try {
		const appOwnsScreen =
			(term.isAlternateScreen?.() ?? false) ||
			(term.hasMouseTracking?.() ?? false);
		if (appOwnsScreen && term.hasSelection?.()) {
			term.clearSelection?.();
		}
	} catch {
		// Selection bridge is best effort; ghostty may be disposed.
	}
}

export interface TerminalHandle {
	sendInput: (data: string) => void;
	/** Paste text through ghostty — wraps in bracketed-paste (DEC 2004) only if the app enabled it. */
	paste: (data: string) => void;
	/** Paste text and submit once, settling unbracketed paste bursts first. */
	submit: (data: string) => void;
	focus: () => void;
	blur: () => void;
	/** Native backend only: take the writer lease from whoever holds it. No-op on tmux. */
	claimWriter: () => void;
}

/** Set once the user has seen the one-time "select text to copy" hint toast. */
const TERMINAL_COPY_HINT_SEEN_KEY = "dev3-terminal-copy-hint-seen";

interface TerminalViewProps {
	ptyUrl: string;
	taskId: string;
	projectId: string;
	onReady?: (handle: TerminalHandle) => void;
	/**
	 * Native backend only: this viewer's write role, and whether the server just
	 * refused something it typed. Never fires for a tmux session.
	 */
	onNativeStatus?: (status: NativeViewerStatus) => void;
	/**
	 * The app refused this socket outright (missing/unknown session). Supplying it
	 * hands recovery to the owner, which renders one shared exited state; without
	 * it the terminal keeps printing the refusal into the canvas, which is what
	 * every tmux session still does.
	 */
	onSessionLost?: (reason: string) => void;
	/**
	 * Touch compose mode (mobile/tablet in browser mode): the terminal must NOT
	 * summon the on-screen keyboard — taps neither focus the hidden textarea nor
	 * forward touch→mouse to the canvas. Text entry goes through TerminalComposer;
	 * the ⌨ raw toggle on ExtraKeyBar flips this off for direct typing.
	 */
	touchComposeMode?: boolean;
}

function TerminalView({ ptyUrl, taskId, projectId, onReady, onNativeStatus, onSessionLost, touchComposeMode }: TerminalViewProps) {
	const t = useT();
	// Mirror t in a ref so the long-lived terminal-setup effect's closures
	// (e.g. the select-to-copy hint) always read the latest translator.
	const tRef = useRef(t);
	tRef.current = t;
	const containerRef = useRef<HTMLDivElement>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const searchBarRef = useRef<TerminalSearchBarHandle | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	// The pane the search resolved to, and its %-rect over the terminal canvas —
	// drawn as a frame so a multi-pane layout shows WHICH pane is being searched.
	const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
	const [searchPaneRect, setSearchPaneRect] = useState<PaneRectPct | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	// Mirrored in a ref so the long-lived setup effect's touch/blur closures see
	// mode flips without re-creating the terminal.
	const touchComposeModeRef = useRef(touchComposeMode ?? false);
	touchComposeModeRef.current = touchComposeMode ?? false;
	const copyDiagnosticsRef = useRef<TerminalCopyDiagnostics | null>(null);
	/** Hides the cursor while input would not reach this terminal. */
	const cursorGateRef = useRef<CursorVisibilityGate | null>(null);
	/** Keeps block, box-drawing and powerline glyphs on the cell background's box. */
	const glyphFitRef = useRef<GlyphCellFit | null>(null);
	// Native backend only. The watermark is what a reconnect resumes from, so it
	// must survive the socket — a tmux session never sets either of these.
	const nativeSeqRef = useRef<number | null>(null);
	const nativeRoleRef = useRef<NativeStreamRole | null>(null);
	/** The PTY's size, which an observer renders at instead of its container's. */
	const ptyGeometryRef = useRef<{ cols: number; rows: number } | null>(null);
	/** Set by the terminal-setup effect; re-runs the fit after geometry or role changes. */
	const refitRef = useRef<(() => void) | null>(null);
	/** Re-fit on a settled layout — see the assignment for why two frames are needed. */
	const refitAfterLayoutRef = useRef<(() => void) | null>(null);
	const onNativeStatusRef = useRef(onNativeStatus);
	onNativeStatusRef.current = onNativeStatus;
	const onSessionLostRef = useRef(onSessionLost);
	onSessionLostRef.current = onSessionLost;
	// Mouse-copy keeps tmux copy mode alive so the scrollback viewport does not
	// jump to live output. Remember when that mode may be active so the next
	// plain click can return to live input without requiring Escape.
	const tmuxCopyModeMayBeActiveRef = useRef(false);
	const mouseGestureDraggedRef = useRef(false);
	const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(
		() => (document.documentElement.dataset.theme as "dark" | "light") || "dark",
	);
	const resolvedThemeRef = useRef(resolvedTheme);
	resolvedThemeRef.current = resolvedTheme;
	// Window focus is tracked separately from DOM focus: activeElement stays put
	// when the app goes to the background, so only this tells the two apart.
	const windowFocusedRef = useRef(document.hasFocus());

	// ── Sync gate (remote mode only) ──────────────────────────────────────────
	// Over a tunnel the redraw that fills this canvas arrives hundreds of ms after
	// the attach, so whatever the canvas held until then reads as live output —
	// either the screen this same viewer had before a resume, or nothing at all.
	// Blur it and say "syncing" until the first batch lands. Desktop never arms it:
	// locally the redraw is one frame away and a flash of overlay is the worse bug.
	const [syncing, setSyncing] = useState(() => isRemote());
	const syncingRef = useRef(syncing);
	const syncGateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	function clearSyncGateTimer() {
		if (syncGateTimerRef.current === null) return;
		clearTimeout(syncGateTimerRef.current);
		syncGateTimerRef.current = null;
	}

	/** Raise the gate for a socket that is about to (re)fill the canvas. */
	function armSyncGate() {
		if (!isRemote()) return;
		clearSyncGateTimer();
		syncGateTimerRef.current = setTimeout(releaseSyncGate, TERMINAL_SYNC_GATE_TIMEOUT_MS);
		if (syncingRef.current) return;
		syncingRef.current = true;
		setSyncing(true);
	}

	/** The canvas now shows this session's own output — or the wait timed out. */
	function releaseSyncGate() {
		clearSyncGateTimer();
		if (!syncingRef.current) return;
		syncingRef.current = false;
		setSyncing(false);
	}

	/**
	 * Would a keystroke right now reach this terminal? Touch compose mode is
	 * exempt — there the composer owns the keyboard by design and the terminal
	 * never holds focus, so gating on focus would hide the cursor forever.
	 */
	function inputReachesTerminal() {
		if (touchComposeModeRef.current) return true;
		if (!windowFocusedRef.current) return false;
		const container = containerRef.current;
		const active = document.activeElement;
		if (!container || !active) return false;
		return active === container || container.contains(active);
	}

	/**
	 * Narrow renderer→backend diagnostic (decision 199). Same-bridge limitation
	 * applies: if the RPC bridge is dead these lines never arrive, so the console
	 * mirror at each call site is what a post-mortem actually reads. The sink is what
	 * survives a RESTART, which the console does not.
	 */
	function logDiagnostic(
		tag: string,
		level: "debug" | "info" | "warn" | "error",
		message: string,
		extra?: Record<string, string | number | boolean | null>,
	) {
		// The whole invocation is guarded, not just the promise: cleanup calls this
		// FIRST, so a synchronous throw here would abort every disposer after it and
		// leak the terminal, its sockets and its listeners. Diagnostics must never be
		// able to break the thing they describe.
		try {
			const request = api.request.logRendererDiagnostic({
				level,
				tag,
				message,
				extra: { taskId: taskId.slice(0, 8), ...(extra ?? {}) },
			});
			if (request && typeof (request as Promise<void>).catch === "function") {
				request.catch(() => {});
			}
		} catch {
			/* diagnostics only */
		}
	}

	function logCopyEvent(
		level: "debug" | "info" | "warn" | "error",
		message: string,
		extra?: Record<string, string | number | boolean | null>,
	) {
		logDiagnostic("terminal-copy", level, message, extra);
	}

	useEffect(() => {
		const observer = new MutationObserver(() => {
			setResolvedTheme((document.documentElement.dataset.theme as "dark" | "light") || "dark");
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);

	// ── Terminal reset via app menu (View > Soft/Hard Reset Terminal) ──
	useEffect(() => {
		function handleSoftReset() {
			const ws = wsRef.current;
			if (ws?.readyState !== WebSocket.OPEN) return;
			// \x0f       = Shift In (select G0 charset)
			// \x1b(B     = Designate G0 as US-ASCII
			// \x1b)B     = Designate G1 as US-ASCII
			// \x1b[!p    = DECSTR (Soft Terminal Reset)
			ws.send("\x0f\x1b(B\x1b)B\x1b[!p");
			console.log("[TerminalView] Soft reset sent");
		}

		function handleHardReset() {
			const term = termRef.current;
			const ws = wsRef.current;

			// 1. Full frontend reset (recreates WASM terminal)
			if (term) {
				try {
					term.reset();
					term.renderer?.remeasureFont();
				} catch { /* disposed */ }
				console.log("[TerminalView] Hard reset: term.reset() + remeasureFont()");
			}

			if (ws?.readyState !== WebSocket.OPEN) return;

			// 2. Send RIS (Reset to Initial State) to PTY/tmux
			ws.send("\x1bc");

			// 3. Force tmux redraw via resize nudge — use the same
			//    row-nudge as the WS-open reconnect path so Hard Reset
			//    doesn't introduce a column-re-wrap flicker.
			if (term) {
				try {
					const [nudge, correct] = buildResizeDance(term.cols, term.rows);
					ws.send(nudge);
					setTimeout(() => {
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(correct);
						}
					}, 50);
				} catch { /* disposed */ }
			}
			console.log("[TerminalView] Hard reset sent");
		}

		window.addEventListener("rpc:terminalSoftReset", handleSoftReset);
		window.addEventListener("rpc:terminalHardReset", handleHardReset);
		return () => {
			window.removeEventListener("rpc:terminalSoftReset", handleSoftReset);
			window.removeEventListener("rpc:terminalHardReset", handleHardReset);
		};
	}, []);

	useEffect(() => {
		function handleOsc52Clipboard(event: Event) {
			const detail = (event as CustomEvent<{ taskId?: string; text?: string }>).detail;
			if (detail?.taskId !== taskId || typeof detail.text !== "string") return;
			const text = detail.text;
			// TEMP DIAGNOSTIC: correlate OSC52 copy payloads with clipboard write results.
			copyDiagnosticsRef.current?.markOsc52Copy(text.length);
			logCopyEvent("info", "osc52 clipboard payload received", {
				len: text.length,
			});
			void writeClipboardText(text).then((method) => {
				logCopyEvent(
					method === "failed" ? "warn" : "info",
					"osc52 clipboard write result",
					{ method, len: text.length },
				);
			});
		}

		window.addEventListener("rpc:osc52Clipboard", handleOsc52Clipboard);
		return () => window.removeEventListener("rpc:osc52Clipboard", handleOsc52Clipboard);
	}, [taskId]);

	useEffect(() => {
		let disposed = false;
		let fitAddon: FitAddon | null = null;
		let ws: WebSocket | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let reconnectAttempt = 0;
		let terminalInputBound = false;
		let wasHidden = document.visibilityState === "hidden";
		let layoutObserver: ResizeObserver | null = null;
		let refitTimer: ReturnType<typeof setTimeout> | null = null;
		let mouseCleanup: (() => void) | undefined;
		let linkUnderlines: FilePathUnderlinesHandle | null = null;
		let filePathLinks: FilePathLinkProvider | null = null;
		let nativeSelectionClipboardCleanup: (() => void) | undefined;
		const termSubs: Array<{ dispose(): void }> = [];
		const diagnosticsId = `terminal-copy-${taskId}-${Math.random().toString(36).slice(2, 8)}`;

		// TEMP DIAGNOSTIC: install per-terminal clipboard instrumentation.
		copyDiagnosticsRef.current = installTerminalCopyDiagnostics({
			id: diagnosticsId,
			taskId: taskId.slice(0, 8),
			log: logCopyEvent,
		});

		console.log("[TerminalView] useEffect fired", { ptyUrl, taskId: taskId.slice(0, 8) });

		// Preload bundled font before creating the terminal.
		// Canvas rendering doesn't trigger CSS @font-face loading, so the
		// font must be ready before ghostty-web measures it for cell metrics.
		const TERMINAL_FONT = "'JetBrainsMono Nerd Font Mono', 'SF Mono', 'Menlo', monospace";
		document.fonts.load(`${TERMINAL_BASE_FONT_SIZE}px ${TERMINAL_FONT}`).then(() => {
			console.log("[TerminalView] Font preloaded, starting setup");
			if (!disposed) setup();
		}).catch(() => {
			console.warn("[TerminalView] Font preload failed, starting setup with fallback");
			if (!disposed) setup();
		});

		function setup() {
			if (!containerRef.current || disposed) {
				console.warn("[TerminalView] setup() aborted", {
					hasContainer: !!containerRef.current,
					disposed,
				});
				return;
			}

			console.log("[TerminalView] Creating ghostty-web Terminal instance...");
			const zoomLevel = getEffectiveZoom();
			const term = new Terminal({
				fontSize: Math.round(TERMINAL_BASE_FONT_SIZE * zoomLevel),
				fontFamily: TERMINAL_FONT,
				cursorBlink: true,
				cursorStyle: "bar",
				theme: resolvedTheme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
			});

			console.log("[TerminalView] Terminal created, loading FitAddon...");
			fitAddon = new FitAddon();
			fitAddon.proposeDimensions = proposeDimensionsWithoutScrollbarReserve.bind(fitAddon);
			fitAddonRef.current = fitAddon;
			term.loadAddon(fitAddon);

			console.log("[TerminalView] Opening terminal in DOM...");
			try {
				term.open(containerRef.current);
			} catch (err) {
				console.error("[TerminalView] term.open() FAILED:", err);
				console.error("[TerminalView] Container state:", {
					clientWidth: containerRef.current?.clientWidth,
					clientHeight: containerRef.current?.clientHeight,
					isConnected: containerRef.current?.isConnected,
				});
				return;
			}
			console.log("[TerminalView] Terminal opened in DOM successfully");
			termRef.current = term;


			// Beta: paint right-to-left rows in visual order (Settings → System →
			// Advanced Experience). The renderer exists only after term.open().
			// A blinking cursor in a terminal nothing is typing into reads as "your
			// keystrokes land here" — they land in the artifact iframe, the kanban
			// board, or another app. Hide it while that is the case. Installed BEFORE
			// the bidi wrapper so the bidi settings toggle, which restores whatever
			// render it wrapped, cannot uninstall this gate along the way.
			if (term.renderer) {
				cursorGateRef.current = installCursorVisibilityGate(term.renderer);
				cursorGateRef.current.setCursorVisible(inputReachesTerminal());
				// Powerline prompts and block-drawn bars are only flush if the glyph
				// shares the background's cell box; the vendor's own metrics do not.
				glyphFitRef.current = installGlyphCellFit(term.renderer);
			}

			if (getTerminalBidiEnabled() && term.renderer) {
				installBidiRender(term.renderer);
			}

			// File paths in output become Cmd/Ctrl+Click links; open behavior is
			// the "File path click action" global setting. The overlay draws a
			// persistent underline under every resolved link so paths read as
			// links without hovering.
			filePathLinks = createFilePathLinkProvider({
				term,
				resolvePaths: async (paths) =>
					(await api.request.resolveTerminalPaths({ taskId, projectId, paths })).resolved,
				onActivate: (resolved, _event, line) => {
					void activateTerminalPath(resolved, tRef.current, line, taskId);
				},
				onResolutionsChanged: () => linkUnderlines?.requestRedraw(),
			});
			term.registerLinkProvider(filePathLinks);
			linkUnderlines = installFilePathUnderlines({
				term,
				container: containerRef.current,
				linksForRows: filePathLinks.linksForRows,
			});

			// ghostty marks the container contenteditable="true", so ANY focus on
			// it (term.focus() after fit, ghostty's own canvas mousedown →
			// parentElement.focus()) summons the on-screen keyboard on iOS/Android
			// the moment a task opens. inputmode="none" keeps the element focusable
			// (hardware keyboards unaffected) but suppresses the virtual keyboard;
			// browser-mode typing goes through the hidden textarea instead.
			if (!isElectrobun) {
				containerRef.current.setAttribute("inputmode", "none");
				// Our touch listeners are passive, so nothing preventDefaults a
				// vertical drag: with the global `touch-action: manipulation` iOS
				// still owns vertical panning — it rubber-bands the (unscrollable)
				// page and aborts the gesture with touchcancel, killing the
				// wheel-synthesis scroll. Opt the terminal out of native touch
				// handling entirely; the pane carousel and our axis arbitration
				// handle every gesture themselves.
				containerRef.current.style.touchAction = "none";
			}

			// Stretch ghostty-web's hidden textarea over the canvas.
			// Without this it's 1x1px in the corner, causing scroll jumps on focus.
			const hiddenTextarea = containerRef.current.querySelector("textarea");
			if (hiddenTextarea) {
				hiddenTextarea.style.fontSize = "16px";
				hiddenTextarea.style.width = "100%";
				hiddenTextarea.style.height = "100%";
				hiddenTextarea.style.clipPath = "none";
				hiddenTextarea.style.opacity = "0";
				hiddenTextarea.style.pointerEvents = "none";
				hiddenTextarea.style.caretColor = "transparent";
				hiddenTextarea.style.zIndex = "-1";

				// In browser mode, keep the textarea focused to prevent
				// the mobile keyboard from dismissing. Re-focus on blur
				// unless another input element actually needs focus.
				if (!isElectrobun) {
					hiddenTextarea.addEventListener("blur", () => {
						if (disposed) return;
						// Compose mode owns the keyboard: re-grabbing focus here would
						// re-summon the OSK right after the composer closes.
						if (touchComposeModeRef.current) return;
						const active = document.activeElement;
						if (!active || active === document.body) {
							setTimeout(() => {
								if (disposed || touchComposeModeRef.current) return;
								hiddenTextarea.focus();
							}, 50);
						}
					});

					// Mobile keyboards use IME composition for letters, but
					// space/digits/punctuation are direct insertText events.
					// We handle both paths explicitly via beforeinput + input.
					let lastSentLen = 0;

					// beforeinput: catch direct (non-composition) keystrokes
					// AND backspace on empty textarea. Called BEFORE the browser
					// modifies the textarea, so we can preventDefault cleanly.
					hiddenTextarea.addEventListener("beforeinput", (e) => {
						if (disposed) return;
						const ie = e as InputEvent;
						if (ie.inputType === "insertText" && ie.data) {
							// Direct input: space, digits, punctuation.
							// Send immediately and prevent insertion into textarea
							// so it doesn't desync with composition tracking.
							if (wsRef.current?.readyState === WebSocket.OPEN) {
								wsRef.current.send(ie.data);
							}
							e.preventDefault();
							return;
						}
						if (ie.inputType === "deleteContentBackward" && hiddenTextarea.value === "") {
							if (wsRef.current?.readyState === WebSocket.OPEN) {
								wsRef.current.send("\x7f");
							}
							e.preventDefault();
						}
					});

					// input: handle composition text incrementally (letters).
					// Each composition update changes textarea value — diff to
					// find new chars and send them one by one.
					hiddenTextarea.addEventListener("input", () => {
						if (disposed) return;
						const val = hiddenTextarea.value;
						if (val.length > lastSentLen) {
							const newChars = val.slice(lastSentLen);
							if (wsRef.current?.readyState === WebSocket.OPEN) {
								wsRef.current.send(newChars);
							}
						} else if (val.length < lastSentLen) {
							const deleted = lastSentLen - val.length;
							for (let i = 0; i < deleted; i++) {
								if (wsRef.current?.readyState === WebSocket.OPEN) {
									wsRef.current.send("\x7f");
								}
							}
						}
						lastSentLen = val.length;
					});

					// compositionend: ghostty-web would send event.data again
					// (double-sending). Neutralize the data so ghostty-web
					// skips it, but let the event propagate so it resets isComposing.
					hiddenTextarea.addEventListener("compositionend", (e) => {
						Object.defineProperty(e, "data", { value: "", writable: false });
						hiddenTextarea.value = "";
						lastSentLen = 0;
					}, { capture: true });
				}
			}

			// ghostty-web registers its OWN canvas listeners that grab focus on any
			// interaction (mousedown → textarea.focus(), touchend → preventDefault +
			// textarea.focus()), bypassing our compose-mode gating and summoning the
			// OSK on every tap / pane-swipe. Capture-phase listeners on the container
			// run BEFORE the canvas target listeners, so in compose mode we stop
			// these events (real, browser-emulated after a tap, or synthesized by
			// MobilePaneCarousel's selection-collapse) before ghostty sees them.
			if (!isElectrobun) {
				const containerEl = containerRef.current;
				const blockInComposeMode = (e: Event) => {
					if (touchComposeModeRef.current) e.stopPropagation();
				};
				for (const type of ["mousedown", "mouseup", "click", "touchend"]) {
					containerEl.addEventListener(type, blockInComposeMode, { capture: true });
				}
			}

			// Touch interaction on the terminal canvas. ghostty-web only understands
			// mouse + wheel events, so we arbitrate one-finger gestures by axis:
			//   • vertical drag → synthesized wheel events, so scrollback (and SGR
			//     mouse scroll in vim/htop/Claude Code) scrolls in BOTH compose and
			//     raw mode — previously nothing scrolled the terminal on a phone.
			//   • tap (raw mode) → mousedown+mouseup at the point, then focus the
			//     hidden textarea (the user gesture that opens the mobile keyboard).
			//   • horizontal drag (raw mode) → drag-selection via mouse translation.
			//     Clearly-horizontal swipes are claimed earlier by MobilePaneCarousel
			//     (ancestor, capture) to switch panes.
			// Compose mode dispatches NO mouse events and never focuses: taps must
			// neither summon the OSK nor start a tmux/SGR drag-selection —
			// TerminalComposer owns text entry; the ⌨ raw toggle restores direct
			// interaction.
			const canvas = containerRef.current.querySelector("canvas");
			if (canvas) {
				const SCROLL_DECIDE_PX = 8; // movement before a drag locks scroll/select
				let touchStartX = 0;
				let touchStartY = 0;
				let touchLastY = 0;
				let touchGesture: "scroll" | "select" | "ignore" | null = null;

				function dispatchMouse(type: string, clientX: number, clientY: number, buttons: number) {
					canvas!.dispatchEvent(new MouseEvent(type, {
						clientX,
						clientY,
						button: 0,
						buttons,
						bubbles: true,
						cancelable: true,
					}));
				}

				canvas.addEventListener("touchstart", (e) => {
					if (e.touches.length !== 1) {
						touchGesture = "ignore"; // pinch / multi-touch is never ours
						return;
					}
					touchStartX = e.touches[0].clientX;
					touchStartY = e.touches[0].clientY;
					touchLastY = touchStartY;
					touchGesture = null;
				}, { passive: true });

				canvas.addEventListener("touchmove", (e) => {
					if (touchGesture === "ignore" || e.touches.length !== 1) return;
					const touch = e.touches[0];
					if (touchGesture === null) {
						const dx = touch.clientX - touchStartX;
						const dy = touch.clientY - touchStartY;
						if (Math.abs(dy) > SCROLL_DECIDE_PX && Math.abs(dy) >= Math.abs(dx)) {
							touchGesture = "scroll";
						} else if (Math.abs(dx) > SCROLL_DECIDE_PX) {
							if (touchComposeModeRef.current) {
								// Horizontal in compose mode belongs to the pane swipe.
								touchGesture = "ignore";
								return;
							}
							touchGesture = "select";
							// Anchor the selection where the finger first went down.
							dispatchMouse("mousedown", touchStartX, touchStartY, 1);
						} else {
							return;
						}
					}
					if (touchGesture === "scroll") {
						// Natural scrolling: finger up (step<0) reveals newer content,
						// which is wheel-down for ghostty — hence the sign flip.
						const step = touch.clientY - touchLastY;
						touchLastY = touch.clientY;
						if (step !== 0) {
							// Coordinates matter: for mouse-tracking apps (tmux/vim)
							// the custom wheel handler maps clientX/Y to the cell that
							// receives the SGR scroll — a default (0,0) would target
							// the top-left cell, i.e. potentially the wrong tmux pane.
							canvas!.dispatchEvent(new WheelEvent("wheel", {
								deltaY: -step,
								deltaMode: 0,
								clientX: touch.clientX,
								clientY: touch.clientY,
								bubbles: true,
								cancelable: true,
							}));
						}
					} else if (touchGesture === "select") {
						dispatchMouse("mousemove", touch.clientX, touch.clientY, 1);
					}
				}, { passive: true });

				canvas.addEventListener("touchend", (e) => {
					const gesture = touchGesture;
					touchGesture = null;
					if (e.changedTouches.length !== 1) return;
					const touch = e.changedTouches[0];
					if (gesture === "select") {
						dispatchMouse("mouseup", touch.clientX, touch.clientY, 0);
						return;
					}
					if (gesture === null && !touchComposeModeRef.current) {
						// MobilePaneCarousel claims clearly-horizontal pane swipes in
						// the capture phase and stops touchmove propagation, so a
						// claimed swipe reaches us with the gesture still undecided.
						// Total displacement tells it apart from a real tap — a swipe
						// must not click, and must not summon the keyboard.
						const dx = touch.clientX - touchStartX;
						const dy = touch.clientY - touchStartY;
						if (Math.hypot(dx, dy) > SCROLL_DECIDE_PX) return;
						// Tap: a click for mouse-reporting apps (tmux/vim/htop)…
						dispatchMouse("mousedown", touch.clientX, touch.clientY, 1);
						dispatchMouse("mouseup", touch.clientX, touch.clientY, 0);
						// …and the user gesture that opens the mobile keyboard (raw mode).
						if (!isElectrobun && hiddenTextarea) {
							hiddenTextarea.focus();
						}
					}
				}, { passive: true });

				canvas.addEventListener("touchcancel", () => {
					touchGesture = null;
				}, { passive: true });
			}

			// Keep the terminal fitted to its container for its whole lifetime.
			// We deliberately do NOT use ghostty's FitAddon.observeResize(): its
			// ResizeObserver drops any callback landing inside the 50ms
			// `_isResizing` window that every fit() opens, and on a browser
			// first-load the container's final flex growth routinely lands in
			// that window — leaving the terminal stuck at a transient small size
			// until a remount (re-opening the task). We drive the fit ourselves
			// and call term.resize directly, which carries no such drop window.
			function refitToContainer() {
				if (disposed) return;
				// An observer does not own the PTY, so it must not reflow the stream to
				// its own width: those bytes were laid out for the writer's geometry and
				// every line reaching the right edge would wrap in the wrong place.
				// Adopt the PTY's shape instead and letterbox inside the container.
				const pty = ptyGeometryRef.current;
				if (pty && nativeRoleRef.current === "observer") {
					try { term.resize(pty.cols, pty.rows); } catch { /* disposed */ }
					return;
				}
				if (!fitAddon) return;
				let dims: { cols: number; rows: number } | undefined;
				try { dims = fitAddon.proposeDimensions(); } catch { return; /* disposed */ }
				if (!dims) return;
				try { term.resize(dims.cols, dims.rows); } catch { /* disposed */ }
			}

			refitRef.current = refitToContainer;
			/**
			 * Re-fit only AFTER the browser has laid the container out again.
			 *
			 * Winning the writer lease removes the read-only strip above the canvas, so
			 * the container grows by exactly that strip's height. Measuring in the same
			 * turn as the role frame reads the PRE-removal box and publishes a PTY one
			 * row too short — then the ResizeObserver corrects it, so the shell sees two
			 * resizes and repaints twice. Two frames is what it takes for React to
			 * commit the removal and the browser to finish layout.
			 */
			refitAfterLayoutRef.current = () => {
				if (disposed) return;
				requestAnimationFrame(() => {
					if (disposed) return;
					requestAnimationFrame(() => refitToContainer());
				});
			};
			let refitScheduled = false;
			function scheduleRefit() {
				if (refitScheduled) return;
				refitScheduled = true;
				refitTimer = setTimeout(() => {
					refitTimer = null;
					refitScheduled = false;
					refitToContainer();
				}, 100);
			}

			let didInitialFit = false;
			layoutObserver = new ResizeObserver(() => {
				const el = containerRef.current;
				if (!el || disposed) return;
				if (el.clientWidth > 0 && el.clientHeight > 0) {
					if (didInitialFit) {
						// A later size change (browser layout settling, window
						// resize, zoom) — re-fit resiliently; never dropped.
						scheduleRefit();
						return;
					}
					didInitialFit = true;
					console.log("[TerminalView] Container has dimensions, fitting terminal", {
						width: el.clientWidth,
						height: el.clientHeight,
					});
					// One rAF after observer to ensure paint pass is complete.
					requestAnimationFrame(() => {
						if (disposed) return;
						try {
							fitAddon!.fit();
							// Touch compose mode: never grab focus on entry — opening a
							// task must not summon the on-screen keyboard. The composer
							// (or the ⌨ raw toggle) asks for the keyboard explicitly.
							if (!touchComposeModeRef.current) term.focus();
							mouseCleanup = setupMouseTracking(term);
							nativeSelectionClipboardCleanup = setupNativeSelectionClipboardBridge(term);

							// Fix Shift+functional keys — intercept before
							// ghostty-web's buggy shortcut swallows the modifier.
							// https://github.com/coder/ghostty-web/issues/109
							term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
								const seq = getShiftKeySequence(event);
								if (seq) {
									const hex = Array.from(seq, c => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
									console.log(`[ShiftKey] intercepted ${event.code} → sending ${seq.length}B: ${hex}`);
									if (wsRef.current?.readyState === WebSocket.OPEN) {
										wsRef.current.send(seq);
									}
									return true;
								}
								return false;
							});

							// TEMP DIAGNOSTIC: log when selection exists before clipboard copy paths run.
							termSubs.push(term.onSelectionChange(() => {
								if (disposed) return;
								try {
									if (!term.hasSelection()) {
										copyDiagnosticsRef.current?.clearSelection();
										return;
									}
									copyDiagnosticsRef.current?.markSelection(
										term.getSelection().length,
										term.hasMouseTracking(),
									);
								} catch {
									copyDiagnosticsRef.current?.clearSelection();
								}
							}));

							// Expose terminal handle for external input (ExtraKeyBar, TerminalComposer)
							onReady?.({
								claimWriter: () => {
									if (wsRef.current?.readyState === WebSocket.OPEN) {
										wsRef.current.send(claimMessage());
									}
								},
								sendInput: (data: string) => {
									if (wsRef.current?.readyState === WebSocket.OPEN) {
										wsRef.current.send(data);
									}
								},
								// ghostty's paste() wraps in \x1b[200~…\x1b[201~ only when the
								// running app enabled DEC 2004 and routes through onData → WS.
								paste: (data: string) => { try { term.paste(data); } catch { /* disposed */ } },
								submit: (data: string) => {
									submitPastedText(data, {
										paste: (value) => term.paste(value),
										sendInput: (value) => {
											if (wsRef.current?.readyState === WebSocket.OPEN) {
												wsRef.current.send(value);
											}
										},
										hasBracketedPaste: () => term.hasBracketedPaste(),
									});
								},
								// In browser mode focus the hidden textarea directly: term.focus()
								// lands on ghostty's container div, which never summons the OSK.
								focus: () => {
									try {
										if (!isElectrobun && hiddenTextarea) hiddenTextarea.focus();
										else term.focus();
									} catch { /* disposed */ }
								},
								blur: () => { try { hiddenTextarea?.blur(); } catch { /* disposed */ } },
							});

							console.log("[TerminalView] Terminal fitted, connecting PTY...");
							connectPty(term, fitAddon!);
						} catch (err) {
							console.error("[TerminalView] Post-layout setup FAILED:", err);
							console.error("[TerminalView] Error details:", {
								message: (err as Error)?.message,
								stack: (err as Error)?.stack,
							});
						}
					});
				}
			});
			layoutObserver.observe(containerRef.current);
		}

		function setupMouseTracking(term: Terminal): () => void {
			const canvas = term.renderer!.getCanvas();
			let trackedButton = -1;
			let mouseDownX = 0;
			let mouseDownY = 0;
			let lastDragCell = "";

			function cellCoords(e: MouseEvent): [number, number] {
				const rect = canvas.getBoundingClientRect();
				const col = Math.max(
					1,
					Math.min(
						Math.floor(
							(e.clientX - rect.left) /
								term.renderer!.charWidth,
						) + 1,
						term.cols,
					),
				);
				const row = Math.max(
					1,
					Math.min(
						Math.floor(
							(e.clientY - rect.top) /
								term.renderer!.charHeight,
						) + 1,
						term.rows,
					),
				);
				return [col, row];
			}

			function sgrMouse(
				btn: number,
				col: number,
				row: number,
				press: boolean,
				repeat = 1,
			) {
				term.input(
					`\x1b[<${btn};${col};${row}${press ? "M" : "m"}`.repeat(repeat),
					true,
				);
			}

			// SGR mouse encoding carries modifiers as bits added to the button
			// code (4=Shift, 8=Meta/Alt, 16=Ctrl). We forward only Alt: tmux
			// passes it through to mouse-owning apps, so Claude Code's built-in
			// Option-click-to-move-cursor receives a real M-click instead of a
			// silently stripped plain click. Shift/Ctrl stay unencoded — Shift
			// is the conventional "bypass mouse reporting" modifier.
			function altBit(e: MouseEvent): number {
				return e.altKey ? 8 : 0;
			}

			function onMouseDown(e: MouseEvent) {
				if (disposed) return;
				try {
					if (!term.hasMouseTracking() || e.button > 2) return;
					// TEMP DIAGNOSTIC: flag mouse-mode interception because it may block normal selection copy.
					copyDiagnosticsRef.current?.markMouseTrackingIntercept(e.button);
					trackedButton = e.button;
					mouseDownX = e.clientX;
					mouseDownY = e.clientY;
					mouseGestureDraggedRef.current = false;
					const [col, row] = cellCoords(e);
					lastDragCell = `${col};${row}`;
					sgrMouse(e.button | altBit(e), col, row, true);
					e.preventDefault();
					e.stopPropagation();
				} catch { /* disposed */ }
			}

			function onMouseUp(e: MouseEvent) {
				if (disposed) return;
				try {
					if (trackedButton < 0) return;
					const btn = trackedButton;
					trackedButton = -1;
					if (!term.hasMouseTracking()) return;
					const [col, row] = cellCoords(e);
					sgrMouse(btn | altBit(e), col, row, false);
					if (btn === 0 && mouseGestureDraggedRef.current) {
						tmuxCopyModeMayBeActiveRef.current = true;
					}
				} catch { /* disposed */ }
			}

			function onMouseMove(e: MouseEvent) {
				if (disposed) return;
				try {
					if (!term.hasMouseTracking() || trackedButton < 0) return;
					if (
						Math.abs(e.clientX - mouseDownX) > 3 ||
						Math.abs(e.clientY - mouseDownY) > 3
					) {
						mouseGestureDraggedRef.current = true;
					}
					const [col, row] = cellCoords(e);
					// One report per cell, not per pixel — a drag across the pane
					// otherwise pumps ~100 redundant sequences/s into the PTY.
					const cell = `${col};${row}`;
					if (cell !== lastDragCell) {
						lastDragCell = cell;
						sgrMouse((trackedButton | altBit(e)) + 32, col, row, true);
					}
					e.stopPropagation();
				} catch { /* disposed */ }
			}

			// iTerm2-style Alt/Option-click to move the readline cursor.
			//
			// Two paths, because dev3's tmux runs with `mouse on`, which keeps
			// the OUTER terminal's mouse tracking enabled for the whole session
			// (verified: tmux emits ?1000h/?1002h/?1006h on attach — decision
			// 098). So `hasMouseTracking()` can NOT distinguish a plain shell
			// pane from a TUI here:
			//
			// - tracking ON (tmux/app owns the mouse): delegate to the backend,
			//   which asks tmux what runs in the clicked pane and sends arrow
			//   keys only for plain shells. The event is NOT swallowed — the
			//   SGR path above still delivers the alt-click to mouse-owning
			//   apps (Claude Code's built-in alt-click keeps working).
			//
			// - tracking OFF (bare PTY, no tmux): move locally via ghostty's
			//   cursor and plain CSI arrows over the WS, and swallow the click
			//   so it never starts a selection. Attached to the canvas's PARENT
			//   in the capture phase so it pre-empts ghostty-web's own canvas
			//   mousedown (bubble-phase) selection handler, which is registered
			//   first and does not check defaultPrevented.
			function onAltClickMove(e: MouseEvent) {
				if (disposed) return;
				try {
					if (!e.altKey || e.button !== 0) return;
					const [toCol, toRow] = cellCoords(e);

					if (term.hasMouseTracking()) {
						const request = api.request.tmuxAltClickMoveCursor({
							taskId,
							col: toCol,
							row: toRow,
						});
						if (request && typeof (request as Promise<unknown>).catch === "function") {
							(request as Promise<unknown>).catch(() => {});
						}
						return;
					}

					const cursor = term.buffer.active;
					const seq = buildCursorMoveSequence(
						cursor.cursorX + 1,
						cursor.cursorY + 1,
						toCol,
						toRow,
					);
					if (seq && wsRef.current?.readyState === WebSocket.OPEN) {
						wsRef.current.send(seq);
					}
					// Swallow the alt-click even when the move is a no-op so it
					// never starts a text selection or fires the copy bridge.
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
				} catch { /* disposed */ }
			}

			const altClickTarget: HTMLElement = containerRef.current ?? canvas;
			altClickTarget.addEventListener("mousedown", onAltClickMove, {
				capture: true,
			});

			canvas.addEventListener("mousedown", onMouseDown, {
				capture: true,
			});
			canvas.addEventListener("mousemove", onMouseMove, {
				capture: true,
			});
			document.addEventListener("mouseup", onMouseUp);

			let scrollAccumulator = 0;
			const wheelPacer = createWheelPacer();

			term.attachCustomWheelEventHandler((e: WheelEvent) => {
				if (disposed) return false;
				try {
					if (!term.hasMouseTracking()) return false;
					const [col, row] = cellCoords(e);

					// Read live so the Settings → Appearance scroll-speed slider
					// takes effect without rebuilding the terminal (cheap cache read).
					const threshold = getScrollThreshold();
					scrollAccumulator += e.deltaY;
					const lines = Math.trunc(scrollAccumulator / threshold);
					if (lines !== 0) {
						scrollAccumulator -= lines * threshold;
						if (lines < 0) tmuxCopyModeMayBeActiveRef.current = true;
						const code = lines < 0 ? 64 : 65;
						// Paced and sent as one write — an unpaced flick overruns the
						// PTY's 1022-byte read window and TUIs paste the sliced tail
						// into their prompt (decision 175).
						const allowed = wheelPacer.take(
							Math.abs(lines),
							performance.now(),
						);
						if (allowed > 0) sgrMouse(code, col, row, true, allowed);
					}
					return true;
				} catch { return false; /* disposed */ }
			});

			return () => {
				altClickTarget.removeEventListener("mousedown", onAltClickMove, {
					capture: true,
				});
				canvas.removeEventListener("mousedown", onMouseDown, {
					capture: true,
				});
				canvas.removeEventListener("mousemove", onMouseMove, {
					capture: true,
				});
				document.removeEventListener("mouseup", onMouseUp);
			};
		}

		function setupNativeSelectionClipboardBridge(term: Terminal): () => void {
			let selectionGestureActive = false;

			function onMouseDown(event: MouseEvent) {
				if (disposed) return;
				try {
					const container = containerRef.current;
					selectionGestureActive =
						!!container &&
						event.target instanceof Node &&
						container.contains(event.target) &&
						!term.hasMouseTracking();
				} catch {
					selectionGestureActive = false;
				}
			}

			function onMouseUp() {
				if (disposed) return;
				if (!selectionGestureActive) return;
				selectionGestureActive = false;
				queueMicrotask(() => {
					if (disposed) return;
					try {
						const mouseTracking = term.hasMouseTracking();
						if (mouseTracking || !term.hasSelection()) return;
						const text = term.getSelection();
						if (!text) return;
						copyDiagnosticsRef.current?.markSelection(text.length, mouseTracking);
						api.request.copyTerminalSelection({
							taskId,
							text,
							mouseTracking,
						}).then(() => {
							// One-time discovery hint: selecting text auto-copies it.
							try {
								if (!localStorage.getItem(TERMINAL_COPY_HINT_SEEN_KEY)) {
									localStorage.setItem(TERMINAL_COPY_HINT_SEEN_KEY, "1");
								toast.info(tRef.current("terminal.copyHint"), { durationMs: 8000, taskId });
								}
							} catch {
								// localStorage unavailable — skip the hint, copy still worked.
							}
						}).catch((err) => {
							logCopyEvent("warn", "backend terminal selection copy failed", {
								len: text.length,
								error: String(err),
							});
						});
					} catch {
						// Selection bridge is best effort; ghostty may be disposed.
					}
				});
			}

			document.addEventListener("mousedown", onMouseDown);
			document.addEventListener("mouseup", onMouseUp);
			return () => {
				document.removeEventListener("mousedown", onMouseDown);
				document.removeEventListener("mouseup", onMouseUp);
			};
		}

		// Strip any remaining OSC 52 sequences (already handled server-side)
		const OSC52_RE =
			/\x1b\]52;[^;]*;[A-Za-z0-9+/=]*(?:\x07|\x1b\\)/g;

		// ── Terminal write batching ─────────────────────────────────────
		// AI agents produce thousands of WS messages per second. Writing
		// each one to ghostty-web individually forces per-write layout and
		// render passes. Instead, we accumulate incoming data and flush in
		// a single term.write() call per animation frame (~60fps).
		let pendingWrite = "";
		let writeRafId: number | null = null;
		// Guards scheduling separately from the frame id: a callback that runs before
		// requestAnimationFrame returns would otherwise leave the id set forever and
		// every later batch would sit in the queue unwritten.
		let writeScheduled = false;
		/** Whether the pending batch carries bytes from the PTY, not our own clear. */
		let pendingFromSocket = false;
		// Reference to the terminal for batched writes (set by connectPty)
		let batchTerm: Terminal | null = null;
		// Rewrites SGR colors unreadable on the current background: pale/dim
		// in light mode, too-dark ink in dark mode. See utils/ansi-theme-adapt.ts.
		const themeFilter = createAnsiThemeFilter();

		function enqueueTermWrite(data: string) {
			pendingWrite += data;
			if (!writeScheduled) {
				writeScheduled = true;
				writeRafId = requestAnimationFrame(() => {
					writeScheduled = false;
					writeRafId = null;
					if (disposed || !pendingWrite || !batchTerm) return;
					const batch = themeFilter(pendingWrite, resolvedThemeRef.current);
					pendingWrite = "";
					if (!batch) return;
					const fromSocket = pendingFromSocket;
					pendingFromSocket = false;
					try {
						batchTerm.write(batch);
						// Only the socket's own output proves the canvas is current; the
						// clear we enqueue ourselves must leave the gate up.
						if (fromSocket) releaseSyncGate();
						// Drop any stale selection left floating over the
						// just-repainted cells when the app owns the screen
						// (alt-screen or primary+mouse-tracking); ghostty-web
						// won't do it on its own.
						clearStaleSelectionOnWrite(batchTerm);
						// ghostty-web never fires onRender, so the write batch is
						// the "content changed" signal for the link underlines.
						linkUnderlines?.requestRedraw();
					} catch {
						// Swallow ghostty-web rendering errors
					}
				});
			}
		}

		/** Publish the writer/observer role, and whether the server just refused input. */
		function reportNativeRole(status: NativeViewerStatus): void {
			const previousRole = nativeRoleRef.current;
			const changed = previousRole !== status.role;
			nativeRoleRef.current = status.role;
			onNativeStatusRef.current?.(status);
			if (!changed) return;
			// Becoming the writer: this viewer now OWNS the canonical geometry, so it
			// publishes its own container's size once — but only after the strip above the
			// canvas is gone and layout has settled. Becoming an observer needs no layout
			// pass at all: it adopts the PTY's shape and ignores its own container.
			if (status.role === "writer") refitAfterLayoutRef.current?.();
			else refitRef.current?.();
		}

		/** Follow the writer's PTY shape; a writer keeps fitting its own container. */
		function adoptPtyGeometry(cols?: number, rows?: number): void {
			if (!cols || !rows) return;
			const previous = ptyGeometryRef.current;
			if (previous?.cols === cols && previous.rows === rows) return;
			ptyGeometryRef.current = { cols, rows };
			refitRef.current?.();
		}

		/**
		 * Apply one native-stream frame. `attach` either continues this viewer's
		 * stream (resumed — write the delta straight on) or replaces the screen, in
		 * which case the terminal is reset FIRST so a rebuilt screen can never be
		 * printed underneath the stale one.
		 */
		function handleNativeFrame(header: NativeStreamHeader, payload: string): void {
			if (header.t === "role") {
				reportNativeRole({
					role: header.role,
					refused: header.refused === true,
					writerAttached: header.writerAttached,
					refusedReason: header.refusedReason,
				});
				adoptPtyGeometry(header.cols, header.rows);
				return;
			}
			let reset = "";
			if (header.t === "attach") {
				nativeSeqRef.current = header.seq;
				// A resumed attach can carry an empty delta — the screen is already
				// correct, so the gate has to lift here rather than wait for output.
				if (header.resumed && !payload) releaseSyncGate();
				reportNativeRole({ role: header.role, refused: false, writerAttached: header.writerAttached });
				adoptPtyGeometry(header.cols, header.rows);
				// RIS in the SAME batch as the replay, so the screen is replaced in one
				// write instead of briefly showing an empty terminal.
				if (!header.resumed) reset = "\x1bc";
			} else if (header.t === "o") {
				nativeSeqRef.current = header.seq;
			} else {
				return;
			}
			const cleaned = payload.replace(OSC52_RE, "");
			if (reset || cleaned) {
				pendingFromSocket = true;
				enqueueTermWrite(reset + cleaned);
			}
		}

		function connectPty(term: Terminal, fit: FitAddon) {
			if (disposed || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
			if (reconnectTimer !== null) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			batchTerm = term;
			// Every socket refills the canvas, so every socket gets its own gate: a
			// resume after backgrounding reattaches to the screen it left behind.
			armSyncGate();
			// A freshly constructed ghostty-web terminal paints the screen the PREVIOUS
			// one held — new Terminal, new canvas node, same leftover pixels — so task B
			// showed task A's output until B's own redraw landed. RIS through the batched
			// write path, which is what actually repaints. Skipped on a native resume:
			// there the server sends a delta that expects the screen it left behind.
			if (nativeSeqRef.current === null) enqueueTermWrite("\x1bc");
			const diagnosticPtyUrl = ptyUrl.replace(/([?&]token=)[^&]+/, "$1***");
			console.log("[TerminalView] Creating WebSocket connection to", diagnosticPtyUrl);
			let socket: WebSocket;
			try {
				socket = new WebSocket(ptyUrlWithSince(ptyUrl, nativeSeqRef.current));
			} catch (err) {
				console.error("[TerminalView] WebSocket constructor FAILED:", err);
				console.error("[TerminalView] URL was:", diagnosticPtyUrl);
				schedulePtyReconnect(term, fit);
				return;
			}
			ws = socket;
			wsRef.current = ws;
			console.log("[TerminalView] WebSocket created, readyState:", ws.readyState);

			socket.onopen = () => {
				if (socket !== ws) return;
				console.log("[TerminalView] WebSocket OPEN");
				if (disposed) return;
				reconnectAttempt = 0;
				const dims = fit.proposeDimensions();
				console.log("[TerminalView] Proposed dimensions:", dims);
				if (dims) {
					// See buildResizeDance() — row-nudge keeps text wrapping
					// identical between the two paints. See decision 041.
					const [nudge, correct] = buildResizeDance(dims.cols, dims.rows);
					socket.send(nudge);
					setTimeout(() => {
						if (socket === ws && socket.readyState === WebSocket.OPEN) {
							socket.send(correct);
						}
					}, 50);
				}
			};

			socket.onmessage = (event) => {
				if (socket !== ws) return;
				if (disposed) return;
				try {
					if (typeof event.data === "string") {
						// A native session frames every message with a watermark header; a
						// tmux session sends bare terminal text and never enters this branch.
						const native = decodeNativeStreamMessage(event.data);
						if (native) {
							handleNativeFrame(native.header, native.payload);
							return;
						}
						const cleaned = event.data.replace(OSC52_RE, "");
						if (cleaned) { pendingFromSocket = true; enqueueTermWrite(cleaned); }
					} else {
						// Binary data — decode and batch with text data
						const str = new TextDecoder().decode(new Uint8Array(event.data));
						if (str) { pendingFromSocket = true; enqueueTermWrite(str); }
					}
				} catch {
					// Swallow ghostty-web rendering errors to avoid flooding
					// analytics with thousands of app_exception events per session.
				}
			};

			socket.onclose = (event) => {
				if (socket !== ws) return;
				ws = null;
				wsRef.current = null;
				console.warn("[TerminalView] WebSocket CLOSED", {
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
				});
				if (disposed) return;
				// A socket that will never deliver a redraw must not leave the canvas
				// blurred behind a "syncing" label that can no longer come true.
				if (event.code === 1000 || isFinalPtyCloseCode(event.code)) releaseSyncGate();
				if (event.code === 1000 && event.wasClean) {
					try { term.writeln("\r\n\x1b[2m[session ended]\x1b[0m"); } catch { /* disposed */ }
					return;
				}
				if (isFinalPtyCloseCode(event.code)) {
					const reason = event.reason || "rejected by the app";
					const owner = onSessionLostRef.current;
					if (owner) {
						owner(reason);
						return;
					}
					try { term.writeln(`\r\n\x1b[2m[no terminal session — ${reason}]\x1b[0m`); } catch { /* disposed */ }
					return;
				}
				schedulePtyReconnect(term, fit);
			};

			socket.onerror = (event) => {
				if (socket !== ws) return;
				console.error("[TerminalView] WebSocket ERROR", event);
			};

			if (!terminalInputBound) termSubs.push(
				term.onData((data) => {
					if (disposed) return;
					if (ws?.readyState === WebSocket.OPEN) {
						ws.send(data);
					}
				}),
				term.onResize(({ cols, rows }) => {
					if (disposed) return;
					if (ws?.readyState === WebSocket.OPEN) {
						ws.send(encodeResizeSequence(cols, rows));
					}
				}),
			);
			terminalInputBound = true;
		}

		function schedulePtyReconnect(term: Terminal, fit: FitAddon): void {
			if (disposed || reconnectTimer !== null) return;
			if (typeof navigator !== "undefined" && navigator.onLine === false) return;
			const delayMs = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
			reconnectAttempt += 1;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				connectPty(term, fit);
			}, delayMs);
		}

		function reconnectPtyOnResume(event: Event): void {
			if (disposed) return;
			if (document.visibilityState === "hidden") {
				wasHidden = true;
				return;
			}
			const term = termRef.current;
			const fit = fitAddonRef.current;
			if (!term || !fit) return;
			const returnedFromBackground = wasHidden;
			wasHidden = false;
			// Ignore the non-persisted pageshow fired during initial page load. A
			// persisted pageshow is a bfcache resume and must replace the socket.
			if (event.type === "pageshow" && !(event as PageTransitionEvent).persisted && !returnedFromBackground) return;
			if (ws?.readyState === WebSocket.OPEN && event.type === "visibilitychange" && !returnedFromBackground) return;
			// Mobile browsers can suspend a socket while it is CONNECTING and never
			// emit its eventual close; an OPEN socket can be stale for the same reason.
			// Foregrounding explicitly replaces either state.
			const stale = ws;
			ws = null;
			wsRef.current = null;
			try { stale?.close(); } catch { /* already closed */ }
			connectPty(term, fit);
		}

		document.addEventListener("visibilitychange", reconnectPtyOnResume);
		window.addEventListener("pageshow", reconnectPtyOnResume);
		window.addEventListener("online", reconnectPtyOnResume);

		// setup() is called after font preload above — not here directly

		return () => {
			console.log("[TerminalView] Cleanup (unmount/re-render)", { taskId: taskId.slice(0, 8) });
			// term.dispose() and fitAddon.dispose() are synchronous, so a slow one blocks
			// the renderer for its whole duration. A duration logged afterwards can only
			// describe a cleanup that FINISHED, so a permanent hang would leave no trace
			// at all — hence a marker before it starts as well. A "started" line with no
			// matching "finished" line is the signature of a teardown that never
			// returned (seq 1407).
			const disposeStartedAt = performance.now();
			// Dispatched BEFORE any synchronous dispose runs, so a teardown that never
			// returns still leaves a "started" line with no matching "finished" — the
			// only evidence a permanent hang can produce. Console AND the durable sink:
			// the console does not survive a restart, and the sink does not survive a
			// dead bridge (decision 199).
			console.debug("[TerminalView] cleanup started", { taskId: taskId.slice(0, 8) });
			// info, not debug: prod/staging/canary run the logger at a minimum of info,
			// so a debug line never reaches the file and the marker would not be durable.
			logDiagnostic("terminal-dispose", "info", "cleanup started");
			disposed = true;
			document.removeEventListener("visibilitychange", reconnectPtyOnResume);
			window.removeEventListener("pageshow", reconnectPtyOnResume);
			window.removeEventListener("online", reconnectPtyOnResume);
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			if (refitTimer !== null) clearTimeout(refitTimer);
			// Cancel pending write batch to prevent writing to disposed terminal
			writeScheduled = false;
			if (writeRafId !== null) {
				cancelAnimationFrame(writeRafId);
				writeRafId = null;
			}
			copyDiagnosticsRef.current?.dispose();
			copyDiagnosticsRef.current = null;
			cursorGateRef.current?.dispose();
			cursorGateRef.current = null;
			glyphFitRef.current?.dispose();
			glyphFitRef.current = null;
			pendingWrite = "";
			layoutObserver?.disconnect();
			mouseCleanup?.();
			linkUnderlines?.dispose();
			linkUnderlines = null;
			filePathLinks?.dispose();
			filePathLinks = null;
			nativeSelectionClipboardCleanup?.();
			// Dispose terminal event subscriptions (onData, onResize) before
			// closing the WebSocket or disposing the terminal to prevent
			// callbacks from firing on a disposed terminal.
			for (const sub of termSubs) {
				try { sub.dispose(); } catch { /* already disposed */ }
			}
			termSubs.length = 0;
			// Neutralize WS handlers before closing to prevent callbacks
			// from firing on a disposed terminal (race condition: close
			// handshake is async, messages can still arrive).
			if (ws) {
				ws.onopen = null;
				ws.onmessage = null;
				ws.onclose = null;
				ws.onerror = null;
			}
			try {
				ws?.close();
			} catch (err) {
				console.error("[TerminalView] ws.close() failed during cleanup:", err);
			}
			wsRef.current = null;
			try {
				fitAddon?.dispose();
			} catch (err) {
				console.error("[TerminalView] fitAddon.dispose() failed:", err);
			}
			fitAddonRef.current = null;
			if (termRef.current) {
				try {
					termRef.current.dispose();
				} catch (err) {
					console.error("[TerminalView] term.dispose() failed:", err);
				}
				termRef.current = null;
			}
			const disposeMs = Math.round(performance.now() - disposeStartedAt);
			console.debug("[TerminalView] cleanup finished", { taskId: taskId.slice(0, 8), disposeMs });
			logDiagnostic("terminal-dispose", "info", "cleanup finished", { disposeMs });
			if (disposeMs >= TERMINAL_DISPOSE_BUDGET_MS) {
				console.warn("[TerminalView] cleanup exceeded its budget", {
					taskId: taskId.slice(0, 8),
					disposeMs,
					budgetMs: TERMINAL_DISPOSE_BUDGET_MS,
				});
				logDiagnostic("terminal-dispose", "warn", "cleanup exceeded its budget", {
					disposeMs,
					budgetMs: TERMINAL_DISPOSE_BUDGET_MS,
				});
			}
		};
	}, [ptyUrl, taskId]);

	useEffect(() => {
		try {
			if (termRef.current) {
				termRef.current.options.theme =
					resolvedTheme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
			}
		} catch { /* disposed */ }
	}, [resolvedTheme]);

	// Keep the cursor in sync with where input actually goes: focus moving to the
	// artifact iframe, another pane, or another app must take the cursor with it.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const sync = () => cursorGateRef.current?.setCursorVisible(inputReachesTerminal());
		// focusout fires BEFORE the next element takes focus, and hopping between
		// the container and its own hidden textarea fires it too — so re-read
		// activeElement a frame later, once focus has settled.
		let frame = 0;
		const syncNextFrame = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(sync);
		};
		const onWindowFocus = () => {
			windowFocusedRef.current = true;
			sync();
		};
		const onWindowBlur = () => {
			windowFocusedRef.current = false;
			sync();
		};

		sync();
		container.addEventListener("focusin", sync);
		container.addEventListener("focusout", syncNextFrame);
		window.addEventListener("focus", onWindowFocus);
		window.addEventListener("blur", onWindowBlur);
		return () => {
			cancelAnimationFrame(frame);
			container.removeEventListener("focusin", sync);
			container.removeEventListener("focusout", syncNextFrame);
			window.removeEventListener("focus", onWindowFocus);
			window.removeEventListener("blur", onWindowBlur);
		};
	}, [touchComposeMode]);

	// When the user starts typing printable characters but nothing has focus
	// (activeElement === body), steal focus to the terminal and forward the key.
	// This handles the case where clicking a kanban card removes terminal focus
	// and the user immediately starts typing without clicking the terminal first.
	useEffect(() => {
		function handleKeydown(e: KeyboardEvent) {
			const active = document.activeElement;
			if (active && active !== document.body) return;
			if (e.ctrlKey || e.altKey || e.metaKey) return;
			if (e.key.length !== 1) return;
			const term = termRef.current;
			if (!term) return;
			try {
				term.focus();
				term.input(e.key, true);
			} catch { return; /* disposed */ }
			e.preventDefault();
		}
		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	}, []);

	useEffect(() => {
		function handleTerminalCopyShortcut(e: KeyboardEvent) {
			const container = containerRef.current;
			const term = termRef.current;
			if (!container || !term) return;
			if (!container.contains(document.activeElement) && document.activeElement !== container) return;
			if (!e.metaKey || e.code !== "KeyC") return;
			try {
				const hasSelection = term.hasSelection();
				const selectionLength = hasSelection ? term.getSelection().length : 0;
				// TEMP DIAGNOSTIC: distinguish manual Cmd+C from auto-copy-on-selection.
				logCopyEvent("info", "cmd+c detected in terminal", {
					selectionLen: selectionLength,
					mouseTracking: term.hasMouseTracking(),
				});
				if (hasSelection) {
					copyDiagnosticsRef.current?.markShortcutCopy(selectionLength, term.hasMouseTracking());
				}
			} catch {
				// Best effort diagnostics only.
			}
		}

		window.addEventListener("keydown", handleTerminalCopyShortcut, { capture: true });
		return () => window.removeEventListener("keydown", handleTerminalCopyShortcut, { capture: true });
	}, [taskId]);

	// Pane shortcuts (⌘D / ⌘⇧D / ⌘W / ⌘T), rebindable via the keymap registry.
	// Capture phase so ghostty-web can't swallow the events, and gated on focus
	// being inside THIS terminal — these combos are only ours while a terminal has
	// focus, which is what lets them share keys with app-level shortcuts.
	useEffect(() => {
		function handleKeydown(e: KeyboardEvent) {
			const container = containerRef.current;
			if (!container) return;
			if (!container.contains(document.activeElement) && document.activeElement !== container) return;

			// `typing: false` — focus IS a terminal here, and that is exactly where
			// these must fire; the flag only exists to protect bare-key bindings.
			// `terminal: true` is NOT relaxed: it is what keeps a plain Ctrl combo
			// (^D, ^W) with the shell, which is why these defaults sit on Ctrl+Shift
			// off macOS.
			const ctx = { typing: false, terminal: true };
			const fire = (run: () => void) => {
				e.preventDefault();
				e.stopPropagation();
				run();
			};
			const pane = (action: TaskPaneAction) =>
				fire(() => void api.request.taskPaneAction({ taskId, action }).catch(() => {}));

			if (matchesShortcut(e, "pane-close", ctx)) pane({ kind: "close" });
			else if (matchesShortcut(e, "pane-split-vertical", ctx)) pane({ kind: "splitV" });
			else if (matchesShortcut(e, "pane-split-horizontal", ctx)) pane({ kind: "splitH" });
			else if (matchesShortcut(e, "tmux-new-window", ctx)) {
				fire(() => void api.request.tmuxNewWindow({ taskId }).catch(() => {}));
			}
		}
		window.addEventListener("keydown", handleKeydown, { capture: true });
		return () => window.removeEventListener("keydown", handleKeydown, { capture: true });
	}, [taskId]);

	// ⌘F (Ctrl+Shift+F elsewhere) — search the terminal via tmux copy-mode.
	// Capture phase so ghostty can't swallow it; gated on focus being inside
	// this terminal (or its search bar) so the browser's native find keeps
	// working everywhere else in remote mode. The combo comes from the registry
	// (`terminal-search`) — plain Ctrl+F is readline's forward-char and must
	// reach the shell.
	useEffect(() => {
		function handleSearchShortcut(e: KeyboardEvent) {
			if (!matchesShortcut(e, "terminal-search", { typing: false, terminal: true })) return;
			const wrapper = wrapperRef.current;
			if (!wrapper) return;
			if (!wrapper.contains(document.activeElement)) return;
			e.preventDefault();
			e.stopPropagation();
			setSearchOpen(true);
			// Already open → re-focus the input and select the query for retyping.
			searchBarRef.current?.focusInput();
		}
		window.addEventListener("keydown", handleSearchShortcut, { capture: true });
		return () => window.removeEventListener("keydown", handleSearchShortcut, { capture: true });
	}, []);

	function closeSearch() {
		setSearchOpen(false);
		setSearchPaneId(null);
		try { termRef.current?.focus(); } catch { /* disposed */ }
	}

	// Frame the searched pane. Fetch the tmux layout once the search resolves a
	// pane (and again if it re-resolves), map that pane's cells to a %-rect over
	// the canvas, and draw a frame — but only when its window has ≥2 panes, so a
	// plain single-pane terminal never gets a redundant border. %-based, so app
	// zoom / resize need no recompute (only a tmux split change would, which is
	// rare mid-search).
	useEffect(() => {
		if (!searchOpen || !searchPaneId) {
			setSearchPaneRect(null);
			return;
		}
		let cancelled = false;
		api.request
			.tmuxLayout({ taskId })
			.then((layout) => {
				if (!cancelled) setSearchPaneRect(paneHighlightRect(layout, searchPaneId));
			})
			.catch(() => {
				if (!cancelled) setSearchPaneRect(null);
			});
		return () => { cancelled = true; };
	}, [searchOpen, searchPaneId, taskId]);

	// When the page becomes visible again (e.g. user returns from another
	// app or switches back to this tab), trigger a resize dance to force
	// tmux to fully redraw. This fixes display glitches (row offsets,
	// stuck/duplicated text) that accumulate while the terminal was hidden.
	useEffect(() => {
		function onVisibilityChange() {
			if (document.hidden) return;
			const ws = wsRef.current;
			const term = termRef.current;
			const fit = fitAddonRef.current;
			if (!ws || ws.readyState !== WebSocket.OPEN || !term || !fit) return;

			let dims: { cols: number; rows: number } | undefined;
			try { dims = fit.proposeDimensions(); } catch { return; /* disposed */ }
			if (!dims) return;

			const [nudge, correct] = buildResizeDance(dims.cols, dims.rows);
			ws.send(nudge);
			setTimeout(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(correct);
				}
			}, 50);
		}

		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);

	// Scale terminal font size with app zoom level.
	// Font-size scaling (not CSS zoom) is used for the app, so canvas isn't
	// bitmap-scaled — we just adjust the terminal's own fontSize.
	// Initial size is set at Terminal construction; this handles live changes.
	useEffect(() => {
		function onZoomChanged(e: Event) {
			const term = termRef.current;
			if (term) {
				try {
					term.options.fontSize = Math.round(TERMINAL_BASE_FONT_SIZE * (e as CustomEvent).detail);
					fitAddonRef.current?.fit();
				} catch { /* disposed */ }
			}
		}
		window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
		return () => window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
	}, []);

	// Apply the BiDi setting live: install or restore the visual-order view and
	// repaint every row, so already-printed output flips without reopening the task.
	useEffect(() => {
		function onBidiChanged(e: Event) {
			const term = termRef.current;
			const renderer = term?.renderer;
			if (!term || !renderer) return;
			try {
				if ((e as CustomEvent<boolean>).detail) installBidiRender(renderer);
				else uninstallBidiRender(renderer);
				if (term.wasmTerm) {
					// Opacity 0 keeps the scrollbar from flashing on a forced frame.
					renderer.render(term.wasmTerm, true, term.viewportY, term, 0);
				}
			} catch { /* disposed */ }
		}
		window.addEventListener(TERMINAL_BIDI_CHANGED_EVENT, onBidiChanged);
		return () => window.removeEventListener(TERMINAL_BIDI_CHANGED_EVENT, onBidiChanged);
	}, []);

	// Intercept ALL paste events: images / large text blocks are saved to disk and
	// their path injected into the PTY; ordinary text goes through term.paste()
	// (bracketed, CR-normalized) — never ghostty's raw container handler.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		function sendPathToPty(path: string) {
			if (wsRef.current?.readyState === WebSocket.OPEN) {
				const escaped = path.replace(/ /g, "\\ ");
				wsRef.current.send(escaped);
			}
			try { termRef.current?.focus(); } catch { /* disposed */ }
		}

		function onPaste(e: ClipboardEvent) {
			const clip = e.clipboardData;
			const text = clip?.getData("text/plain") ?? "";

			// Attachments (images / large text) need a project to upload into.
			if (projectId) {
				// The paste event's own files are the reliable source: the webview hands
				// over real PNG bytes for a clipboard bitmap. The host-clipboard RPC below
				// is the fallback — on Windows it returns raw DIB bytes, and in remote mode
				// it reads the app host's clipboard rather than the user's device.
				const pastedImages = imageFilesFromClipboard(clip);
				if (pastedImages.length > 0) {
					e.preventDefault();
					e.stopImmediatePropagation();
					void Promise.all(pastedImages.map((f) => uploadDroppedFile(projectId, f)))
						.then((paths) => {
							const line = paths.filter((p): p is string => Boolean(p)).map((p) => p.replace(/ /g, "\\ ")).join(" ");
							if (line) sendPathToPty(line);
							else toast.error(t("imagePaste.failed"), { taskId });
						})
						.catch((err) => {
							console.error("[TerminalView] Image paste upload failed:", err);
							toast.error(t("fileDrop.uploadFailed", { error: String(err instanceof Error ? err.message : err) }), { taskId });
						});
					return;
				}

				let hasImage = false;
				const items = clip?.items;
				if (items) {
					for (let i = 0; i < items.length; i++) {
						if (items[i].type.startsWith("image/")) {
							hasImage = true;
							break;
						}
					}
				}

				if (hasImage) {
					e.preventDefault();
					e.stopImmediatePropagation();
					api.request.pasteClipboardImage({ projectId }).then((result) => {
						if (result) sendPathToPty(result.path);
						else toast.error(t("imagePaste.failed"), { taskId });
					}).catch((err) => {
						console.error("[TerminalView] Image paste failed:", err);
						toast.error(t("imagePaste.failed"), { taskId });
					});
					return;
				}

				// Large text paste → save to a .txt file and inject its path instead of
				// streaming the whole block into the PTY.
				if (isLargeTextPaste(text)) {
					e.preventDefault();
					e.stopImmediatePropagation();
					uploadPastedText(projectId, text).then((path) => {
						if (path) sendPathToPty(path);
					}).catch((err) => {
						console.error("[TerminalView] Large text paste failed:", err);
					});
					return;
				}
			}

			// Ordinary text paste: route it through ghostty's bracketed paste
			// explicitly. ghostty-web has TWO paste handlers — the textarea one wraps
			// in DEC 2004, but the container one (hit when term.focus() puts focus on
			// the contenteditable div, i.e. desktop/remote) sends the raw clipboard
			// bytes. Raw CRLF/LF then submits after the first line. We register this
			// listener before ghostty's, so stopImmediatePropagation() pre-empts both
			// of its handlers and gives one deterministic, bracketed path.
			if (!text) return;
			// Check the terminal BEFORE swallowing the event: during PTY
			// recreation termRef is briefly null while this listener is still
			// attached. Suppressing then bailing would silently drop the paste —
			// leave it for whatever handler is present instead.
			const term = termRef.current;
			if (!term) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			try {
				term.paste(normalizePastedText(text));
			} catch {
				// Terminal disposed mid-paste — nothing to do.
			}
		}

		container.addEventListener("paste", onPaste, { capture: true });
		return () => container.removeEventListener("paste", onPaste, { capture: true });
	}, [projectId, taskId, t]);

	function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
		e.preventDefault();
		e.stopPropagation();
	}

	async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
		e.preventDefault();
		e.stopPropagation();

		const files = Array.from(e.dataTransfer.files);
		if (files.length === 0) return;

		const paths = await Promise.all(
			files.map(async (f) => {
				try {
					const uploadedPath = await uploadDroppedFile(projectId, f);
					return uploadedPath ? uploadedPath.replace(/ /g, "\\ ") : null;
				} catch (err) {
					console.error(`[TerminalView] file upload failed for "${f.name}":`, err);
					toast.error(t("fileDrop.uploadFailed", { error: String(err instanceof Error ? err.message : err) }), { taskId });
					return null;
				}
			}),
		);
		const text = paths.filter((path): path is string => Boolean(path)).join(" ");

		if (!text) {
			try { termRef.current?.focus(); } catch { /* disposed */ }
			return;
		}

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(text);
		}
		try { termRef.current?.focus(); } catch { /* disposed */ }
	}

	const termBg = resolvedTheme === "light"
		? LIGHT_TERMINAL_THEME.background
		: DARK_TERMINAL_THEME.background;

	// The gate starts raised in remote mode, before any socket exists, so its
	// deadline starts with the mount: a setup that never reaches connectPty must
	// not leave the canvas blurred forever.
	useEffect(() => {
		armSyncGate();
		return clearSyncGateTimer;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function handleTerminalClick(event: React.MouseEvent<HTMLDivElement>) {
		try { termRef.current?.focus(); } catch { /* disposed */ }
		if (touchComposeModeRef.current) return;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

		// A browser may emit click after a drag. Keep the copy-mode viewport for
		// that gesture; only the next distinct plain click means "resume input".
		if (mouseGestureDraggedRef.current) {
			mouseGestureDraggedRef.current = false;
			return;
		}
		if (!tmuxCopyModeMayBeActiveRef.current) return;

		tmuxCopyModeMayBeActiveRef.current = false;
		api.request.exitCopyModeAllPanes({ taskId }).catch(() => {
			// Best effort — the pane may already have returned to live input.
		});
	}

	return (
		<div ref={wrapperRef} className="relative w-full h-full min-h-0 overflow-hidden">
			<div
				ref={containerRef}
				className="w-full h-full overflow-hidden"
				data-terminal="true"
				style={{ backgroundColor: termBg }}
				onClick={handleTerminalClick}
				onContextMenu={(e) => e.preventDefault()}
				onDragOver={handleDragOver}
				onDrop={handleDrop}
			/>
			{syncing && (
				<div
					data-testid="terminal-sync-gate"
					role="status"
					aria-live="polite"
					aria-busy="true"
					// Never blocks input: typing goes to the container underneath, and a
					// click while syncing still focuses the terminal it is covering.
					className="pointer-events-none absolute inset-0 z-[15] flex items-center justify-center gap-3 bg-base/60 backdrop-blur-[6px]"
				>
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					<span className="text-fg-3 text-sm">{t("terminal.syncing")}</span>
				</div>
			)}
			{searchOpen && searchPaneRect && (
				<div
					className="pointer-events-none absolute z-20 rounded-sm border-2 border-accent bg-accent/5"
					style={{
						left: `${searchPaneRect.leftPct}%`,
						top: `${searchPaneRect.topPct}%`,
						width: `${searchPaneRect.widthPct}%`,
						height: `${searchPaneRect.heightPct}%`,
					}}
					aria-hidden="true"
					data-testid="terminal-search-pane-frame"
				/>
			)}
			{searchOpen && (
				<TerminalSearchBar
					ref={searchBarRef}
					taskId={taskId}
					onClose={closeSearch}
					onPaneResolved={setSearchPaneId}
				/>
			)}
		</div>
	);
}

export default TerminalView;
