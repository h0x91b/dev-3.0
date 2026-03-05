import { useEffect, useRef, useState } from "react";
import { Terminal, FitAddon } from "ghostty-web";
import { api } from "./rpc";
import { getShiftKeySequence } from "./shift-key-sequences";
import { getZoomApi } from "./zoom";

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
	yellow: "#dbab09",
	blue: "#005cc5",
	magenta: "#5a32a3",
	cyan: "#0598bc",
	white: "#6a737d",
	brightBlack: "#959da5",
	brightRed: "#cb2431",
	brightGreen: "#22863a",
	brightYellow: "#f9c513",
	brightBlue: "#0366d6",
	brightMagenta: "#6f42c1",
	brightCyan: "#3192aa",
	brightWhite: "#d1d5da",
};

interface TerminalViewProps {
	ptyUrl: string;
	taskId: string;
}

function TerminalView({ ptyUrl, taskId }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(
		() => (document.documentElement.dataset.theme as "dark" | "light") || "dark",
	);

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
				term.reset();
				term.renderer?.remeasureFont();
				console.log("[TerminalView] Hard reset: term.reset() + remeasureFont()");
			}

			if (ws?.readyState !== WebSocket.OPEN) return;

			// 2. Send RIS (Reset to Initial State) to PTY/tmux
			ws.send("\x1bc");

			// 3. Force tmux redraw via resize nudge
			if (term) {
				const cols = term.cols;
				const rows = term.rows;
				ws.send(`\x1b]resize;${Math.max(2, cols - 1)};${rows}\x07`);
				setTimeout(() => {
					if (ws.readyState === WebSocket.OPEN) {
						ws.send(`\x1b]resize;${cols};${rows}\x07`);
					}
				}, 50);
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
		let disposed = false;
		let fitAddon: FitAddon | null = null;
		let ws: WebSocket | null = null;
		let layoutObserver: ResizeObserver | null = null;
		let mouseCleanup: (() => void) | undefined;

		console.log("[TerminalView] useEffect fired", { ptyUrl, taskId: taskId.slice(0, 8) });

		// Preload bundled font before creating the terminal.
		// Canvas rendering doesn't trigger CSS @font-face loading, so the
		// font must be ready before ghostty-web measures it for cell metrics.
		const TERMINAL_FONT = "'JetBrains Mono', 'SF Mono', 'Menlo', monospace";
		document.fonts.load(`14px ${TERMINAL_FONT}`).then(() => {
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
			const zoomLevel = getZoomApi()?.getZoom?.() ?? 1;
			const term = new Terminal({
				fontSize: Math.round(14 * zoomLevel),
				fontFamily: TERMINAL_FONT,
				cursorBlink: true,
				cursorStyle: "bar",
				theme: resolvedTheme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
			});

			console.log("[TerminalView] Terminal created, loading FitAddon...");
			fitAddon = new FitAddon();
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

			// Use ResizeObserver to detect when the container gets its final
			// flex-computed dimensions. Unlike requestAnimationFrame heuristics,
			// this fires exactly when layout is done — no timing guesses.
			layoutObserver = new ResizeObserver(() => {
				const el = containerRef.current;
				if (!el || disposed) return;
				if (el.clientWidth > 0 && el.clientHeight > 0) {
					layoutObserver?.disconnect();
					layoutObserver = null;
					console.log("[TerminalView] Container has dimensions, fitting terminal", {
						width: el.clientWidth,
						height: el.clientHeight,
					});
					// One rAF after observer to ensure paint pass is complete.
					requestAnimationFrame(() => {
						if (disposed) return;
						try {
							fitAddon!.fit();
							fitAddon!.observeResize();
							term.focus();
							mouseCleanup = setupMouseTracking(term);

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
			) {
				term.input(
					`\x1b[<${btn};${col};${row}${press ? "M" : "m"}`,
					true,
				);
			}

			function onMouseDown(e: MouseEvent) {
				if (!term.hasMouseTracking() || e.button > 2) return;
				trackedButton = e.button;
				const [col, row] = cellCoords(e);
				sgrMouse(e.button, col, row, true);
				e.preventDefault();
				e.stopPropagation();
			}

			function onMouseUp(e: MouseEvent) {
				if (trackedButton < 0) return;
				const btn = trackedButton;
				trackedButton = -1;
				if (!term.hasMouseTracking()) return;
				const [col, row] = cellCoords(e);
				sgrMouse(btn, col, row, false);
			}

			function onMouseMove(e: MouseEvent) {
				if (!term.hasMouseTracking() || trackedButton < 0) return;
				const [col, row] = cellCoords(e);
				sgrMouse(trackedButton + 32, col, row, true);
				e.stopPropagation();
			}

			canvas.addEventListener("mousedown", onMouseDown, {
				capture: true,
			});
			canvas.addEventListener("mousemove", onMouseMove, {
				capture: true,
			});
			document.addEventListener("mouseup", onMouseUp);

			let scrollAccumulator = 0;
			const SCROLL_THRESHOLD = 50;

			term.attachCustomWheelEventHandler((e: WheelEvent) => {
				if (!term.hasMouseTracking()) return false;
				const [col, row] = cellCoords(e);

				scrollAccumulator += e.deltaY;
				const lines = Math.trunc(scrollAccumulator / SCROLL_THRESHOLD);
				if (lines !== 0) {
					scrollAccumulator -= lines * SCROLL_THRESHOLD;
					const code = lines < 0 ? 64 : 65;
					const count = Math.abs(lines);
					for (let i = 0; i < count; i++) {
						sgrMouse(code, col, row, true);
					}
				}
				return true;
			});

			return () => {
				canvas.removeEventListener("mousedown", onMouseDown, {
					capture: true,
				});
				canvas.removeEventListener("mousemove", onMouseMove, {
					capture: true,
				});
				document.removeEventListener("mouseup", onMouseUp);
			};
		}

		// Strip any remaining OSC 52 sequences (already handled server-side)
		const OSC52_RE =
			/\x1b\]52;[^;]*;[A-Za-z0-9+/=]*(?:\x07|\x1b\\)/g;

		function connectPty(term: Terminal, fit: FitAddon) {
			console.log("[TerminalView] Creating WebSocket connection to", ptyUrl);
			try {
				ws = new WebSocket(ptyUrl);
			} catch (err) {
				console.error("[TerminalView] WebSocket constructor FAILED:", err);
				console.error("[TerminalView] URL was:", ptyUrl);
				return;
			}
			wsRef.current = ws;
			console.log("[TerminalView] WebSocket created, readyState:", ws.readyState);

			ws.onopen = () => {
				console.log("[TerminalView] WebSocket OPEN");
				const dims = fit.proposeDimensions();
				console.log("[TerminalView] Proposed dimensions:", dims);
				if (dims) {
					// Resize dance: send slightly different dimensions first,
					// then correct ones after a short delay. This forces two
					// SIGWINCHes even if the PTY already has the same size
					// (reconnection case). The kernel skips SIGWINCH for
					// same-size resizes, so the nudge guarantees the app
					// receives SIGWINCH and does a full screen redraw.
					const nudgeCols = Math.max(2, dims.cols - 1);
					ws?.send(`\x1b]resize;${nudgeCols};${dims.rows}\x07`);
					setTimeout(() => {
						if (ws?.readyState === WebSocket.OPEN) {
							ws.send(
								`\x1b]resize;${dims.cols};${dims.rows}\x07`,
							);
						}
					}, 50);
				}
			};

			ws.onmessage = (event) => {
				if (typeof event.data === "string") {
					const cleaned = event.data.replace(OSC52_RE, "");
					if (cleaned) term.write(cleaned);
				} else {
					term.write(new Uint8Array(event.data));
				}
			};

			ws.onclose = (event) => {
				console.warn("[TerminalView] WebSocket CLOSED", {
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
				});
				term.writeln("\r\n\x1b[2m[session ended]\x1b[0m");
			};

			ws.onerror = (event) => {
				console.error("[TerminalView] WebSocket ERROR", event);
				term.writeln("\x1b[31mFailed to connect to PTY server\x1b[0m");
			};

			term.onData((data) => {
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(data);
				}
			});

			term.onResize(({ cols, rows }) => {
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(`\x1b]resize;${cols};${rows}\x07`);
				}
			});
		}

		// setup() is called after font preload above — not here directly

		return () => {
			console.log("[TerminalView] Cleanup (unmount/re-render)", { taskId: taskId.slice(0, 8) });
			disposed = true;
			layoutObserver?.disconnect();
			mouseCleanup?.();
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
			if (termRef.current) {
				try {
					termRef.current.dispose();
				} catch (err) {
					console.error("[TerminalView] term.dispose() failed:", err);
				}
				termRef.current = null;
			}
		};
	}, [ptyUrl, taskId]);

	useEffect(() => {
		if (termRef.current) {
			termRef.current.options.theme =
				resolvedTheme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
		}
	}, [resolvedTheme]);

	// Scale terminal font size with app zoom level.
	// Font-size scaling (not CSS zoom) is used for the app, so canvas isn't
	// bitmap-scaled — we just adjust the terminal's own fontSize.
	const BASE_FONT_SIZE = 14;
	useEffect(() => {
		function applyTerminalZoom(zoomLevel: number) {
			const term = termRef.current;
			if (term) {
				term.options.fontSize = Math.round(BASE_FONT_SIZE * zoomLevel);
			}
		}

		const zoom = getZoomApi();
		applyTerminalZoom(zoom.getZoom());

		function onZoomChanged(e: Event) {
			applyTerminalZoom((e as CustomEvent).detail);
		}
		window.addEventListener("zoom-changed", onZoomChanged);
		return () => window.removeEventListener("zoom-changed", onZoomChanged);
	}, []);

	function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
		e.preventDefault();
		e.stopPropagation();
	}

	async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
		e.preventDefault();
		e.stopPropagation();

		const files = Array.from(e.dataTransfer.files);
		if (files.length === 0) return;

		// WKWebView doesn't expose native file paths — resolve via Spotlight in main process.
		const paths = await Promise.all(
			files.map(async (f) => {
				const resolved = await api.request.resolveFilename({
					filename: f.name,
					size: f.size,
					lastModified: f.lastModified,
				});
				const p = resolved ?? f.name;
				return p.replace(/ /g, "\\ ");
			}),
		);
		const text = paths.join(" ");

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(text);
		}
		termRef.current?.focus();
	}

	const termBg = resolvedTheme === "light"
		? LIGHT_TERMINAL_THEME.background
		: DARK_TERMINAL_THEME.background;

	return (
		<div
			ref={containerRef}
			className="w-full h-full min-h-0 overflow-hidden"
			data-terminal="true"
			style={{ backgroundColor: termBg }}
			onClick={() => termRef.current?.focus()}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		/>
	);
}

export default TerminalView;
