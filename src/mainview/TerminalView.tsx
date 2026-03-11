import { useEffect, useRef, useState } from "react";
import { Terminal, FitAddon } from "ghostty-web";
import { api } from "./rpc";
import { getShiftKeySequence } from "./shift-key-sequences";
import { getZoom, ZOOM_CHANGED_EVENT } from "./zoom";
import { TERMINAL_KEYMAPS, getKeymapPreset, KEYMAP_CHANGED_EVENT } from "./terminal-keymaps";

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

const TERMINAL_BASE_FONT_SIZE = 14;

interface TerminalViewProps {
	ptyUrl: string;
	taskId: string;
	projectId: string;
}

function TerminalView({ ptyUrl, taskId, projectId }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
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
				try {
					term.reset();
					term.renderer?.remeasureFont();
				} catch { /* disposed */ }
				console.log("[TerminalView] Hard reset: term.reset() + remeasureFont()");
			}

			if (ws?.readyState !== WebSocket.OPEN) return;

			// 2. Send RIS (Reset to Initial State) to PTY/tmux
			ws.send("\x1bc");

			// 3. Force tmux redraw via resize nudge
			if (term) {
				try {
					const cols = term.cols;
					const rows = term.rows;
					ws.send(`\x1b]resize;${Math.max(2, cols - 1)};${rows}\x07`);
					setTimeout(() => {
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(`\x1b]resize;${cols};${rows}\x07`);
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
		let disposed = false;
		let fitAddon: FitAddon | null = null;
		let ws: WebSocket | null = null;
		let layoutObserver: ResizeObserver | null = null;
		let mouseCleanup: (() => void) | undefined;
		const termSubs: Array<{ dispose(): void }> = [];

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
			const zoomLevel = getZoom();
			const term = new Terminal({
				fontSize: Math.round(TERMINAL_BASE_FONT_SIZE * zoomLevel),
				fontFamily: TERMINAL_FONT,
				cursorBlink: true,
				cursorStyle: "bar",
				theme: resolvedTheme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
			});

			console.log("[TerminalView] Terminal created, loading FitAddon...");
			fitAddon = new FitAddon();
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

			// Prevent mobile browser auto-zoom when the hidden textarea gains focus.
			// ghostty-web creates a 1x1px textarea in the corner for keyboard input.
			// Chrome auto-zooms to it on focus. Fix:
			// 1. Stretch textarea over the canvas (not offscreen)
			// 2. On focus, lock viewport scale to the current initial scale
			//    (e.g. viewport=1024 on a 360px phone → scale ≈ 0.35;
			//     setting maximum-scale=1 would allow 3x zoom — wrong!)
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

				// Lock viewport scale on focus to prevent auto-zoom.
				// The initial scale = screen.width / viewport-width. We must use
				// that exact value as maximum-scale, not "1" (which is zoomed in).
				const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
				if (viewportMeta) {
					function getInitialScale(): string {
						const viewportWidth = window.innerWidth;
						// visualViewport.scale tells us the current zoom level
						const currentScale = window.visualViewport?.scale ?? 1;
						// screen.width / (innerWidth * currentScale) gives us the
						// ratio the browser uses to fit the viewport on screen
						const fitScale = screen.width / (viewportWidth * currentScale);
						return fitScale.toFixed(4);
					}

					hiddenTextarea.addEventListener("focus", () => {
						const scale = getInitialScale();
						const base = viewportMeta.content
							.replace(/,?\s*maximum-scale=[^,]*/g, "")
							.replace(/,?\s*minimum-scale=[^,]*/g, "");
						viewportMeta.content = `${base}, minimum-scale=${scale}, maximum-scale=${scale}`;
					});
					hiddenTextarea.addEventListener("blur", () => {
						viewportMeta.content = viewportMeta.content
							.replace(/,?\s*maximum-scale=[^,]*/g, "")
							.replace(/,?\s*minimum-scale=[^,]*/g, "");
					});
				}
			}

			// Translate touch events to mouse events for mobile terminal interaction.
			// ghostty-web only listens for mousedown/mousemove/mouseup on the canvas,
			// so touch events (taps) don't trigger mouse reporting to tmux/vim/etc.
			const canvas = containerRef.current.querySelector("canvas");
			if (canvas) {
				function touchToMouse(type: string, touch: Touch) {
					const mouseEvent = new MouseEvent(type, {
						clientX: touch.clientX,
						clientY: touch.clientY,
						button: 0,
						buttons: 1,
						bubbles: true,
						cancelable: true,
					});
					canvas!.dispatchEvent(mouseEvent);
				}

				canvas.addEventListener("touchstart", (e) => {
					if (e.touches.length === 1) {
						touchToMouse("mousedown", e.touches[0]);
					}
				}, { passive: true });

				canvas.addEventListener("touchend", (e) => {
					if (e.changedTouches.length === 1) {
						touchToMouse("mouseup", e.changedTouches[0]);
					}
				}, { passive: true });

				canvas.addEventListener("touchmove", (e) => {
					if (e.touches.length === 1) {
						touchToMouse("mousemove", e.touches[0]);
					}
				}, { passive: true });
			}

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
				if (disposed) return;
				try {
					if (!term.hasMouseTracking() || e.button > 2) return;
					trackedButton = e.button;
					const [col, row] = cellCoords(e);
					sgrMouse(e.button, col, row, true);
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
					sgrMouse(btn, col, row, false);
				} catch { /* disposed */ }
			}

			function onMouseMove(e: MouseEvent) {
				if (disposed) return;
				try {
					if (!term.hasMouseTracking() || trackedButton < 0) return;
					const [col, row] = cellCoords(e);
					sgrMouse(trackedButton + 32, col, row, true);
					e.stopPropagation();
				} catch { /* disposed */ }
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
				if (disposed) return false;
				try {
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
				} catch { return false; /* disposed */ }
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
				if (disposed) return;
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
				if (disposed) return;
				try {
					if (typeof event.data === "string") {
						const cleaned = event.data.replace(OSC52_RE, "");
						if (cleaned) term.write(cleaned);
					} else {
						term.write(new Uint8Array(event.data));
					}
				} catch {
					// Swallow ghostty-web rendering errors to avoid flooding
					// analytics with thousands of app_exception events per session.
				}
			};

			ws.onclose = (event) => {
				console.warn("[TerminalView] WebSocket CLOSED", {
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
				});
				if (disposed) return;
				try { term.writeln("\r\n\x1b[2m[session ended]\x1b[0m"); } catch { /* disposed */ }
			};

			ws.onerror = (event) => {
				console.error("[TerminalView] WebSocket ERROR", event);
				if (disposed) return;
				try { term.writeln("\x1b[31mFailed to connect to PTY server\x1b[0m"); } catch { /* disposed */ }
			};

			termSubs.push(
				term.onData((data) => {
					if (disposed) return;
					if (ws?.readyState === WebSocket.OPEN) {
						ws.send(data);
					}
				}),
				term.onResize(({ cols, rows }) => {
					if (disposed) return;
					if (ws?.readyState === WebSocket.OPEN) {
						ws.send(`\x1b]resize;${cols};${rows}\x07`);
					}
				}),
			);
		}

		// setup() is called after font preload above — not here directly

		return () => {
			console.log("[TerminalView] Cleanup (unmount/re-render)", { taskId: taskId.slice(0, 8) });
			disposed = true;
			layoutObserver?.disconnect();
			mouseCleanup?.();
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

	// Terminal keymap shortcuts (configurable preset).
	// Uses capture phase so ghostty-web can't swallow the events.
	// Only fires when the terminal container has focus, to avoid
	// accidental triggers while typing in other UI fields.
	const keymapRef = useRef(getKeymapPreset());
	useEffect(() => {
		function onKeymapChanged(e: Event) {
			keymapRef.current = (e as CustomEvent).detail;
		}
		window.addEventListener(KEYMAP_CHANGED_EVENT, onKeymapChanged);
		return () => window.removeEventListener(KEYMAP_CHANGED_EVENT, onKeymapChanged);
	}, []);

	useEffect(() => {
		function handleKeydown(e: KeyboardEvent) {
			const container = containerRef.current;
			if (!container) return;
			if (!container.contains(document.activeElement) && document.activeElement !== container) return;

			const bindings = TERMINAL_KEYMAPS[keymapRef.current] ?? [];
			const binding = bindings.find(
				(b) =>
					b.code === e.code &&
					!!b.meta === e.metaKey &&
					!!b.ctrl === e.ctrlKey &&
					(b.shift === undefined || b.shift === e.shiftKey),
			);
			if (!binding) return;

			e.preventDefault();
			e.stopPropagation();
			api.request.tmuxAction({ taskId, action: binding.action }).catch(() => {});
		}
		window.addEventListener("keydown", handleKeydown, { capture: true });
		return () => window.removeEventListener("keydown", handleKeydown, { capture: true });
	}, [taskId]);

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

			const nudgeCols = Math.max(2, dims.cols - 1);
			ws.send(`\x1b]resize;${nudgeCols};${dims.rows}\x07`);
			setTimeout(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(`\x1b]resize;${dims.cols};${dims.rows}\x07`);
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

	// Intercept paste events containing images (clipboard → save to disk → inject path into PTY).
	// Normal text paste is unaffected — event propagates to ghostty-web as usual.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		function onPaste(e: ClipboardEvent) {
			const items = e.clipboardData?.items;
			if (!items) return;

			let hasImage = false;
			for (let i = 0; i < items.length; i++) {
				if (items[i].type.startsWith("image/")) {
					hasImage = true;
					break;
				}
			}
			if (!hasImage) return;

			e.preventDefault();
			e.stopPropagation();

			api.request.pasteClipboardImage({ projectId }).then((result) => {
				if (result && wsRef.current?.readyState === WebSocket.OPEN) {
					const escaped = result.path.replace(/ /g, "\\ ");
					wsRef.current.send(escaped);
				}
				try { termRef.current?.focus(); } catch { /* disposed */ }
			}).catch((err) => {
				console.error("[TerminalView] Image paste failed:", err);
			});
		}

		container.addEventListener("paste", onPaste, { capture: true });
		return () => container.removeEventListener("paste", onPaste, { capture: true });
	}, [projectId]);

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
		try { termRef.current?.focus(); } catch { /* disposed */ }
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
			onClick={() => { try { termRef.current?.focus(); } catch { /* disposed */ } }}
			onContextMenu={(e) => e.preventDefault()}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		/>
	);
}

export default TerminalView;
