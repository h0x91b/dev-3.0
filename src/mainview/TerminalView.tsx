import { useEffect, useRef } from "react";
import { Terminal, FitAddon } from "ghostty-web";
import { api } from "./rpc";

interface TerminalViewProps {
	ptyUrl: string;
	taskId: string;
}

function TerminalView({ ptyUrl, taskId }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const wsRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		let disposed = false;
		let fitAddon: FitAddon | null = null;
		let ws: WebSocket | null = null;
		let layoutObserver: ResizeObserver | null = null;
		let mouseCleanup: (() => void) | undefined;

		function setup() {
			if (!containerRef.current || disposed) return;

			const term = new Terminal({
				fontSize: 14,
				fontFamily:
					"'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
				cursorBlink: true,
				cursorStyle: "bar",
				theme: {
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
				},
			});

			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.open(containerRef.current);
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
					// One rAF after observer to ensure paint pass is complete.
					requestAnimationFrame(() => {
						if (disposed) return;
						fitAddon!.fit();
						fitAddon!.observeResize();
						term.focus();
						mouseCleanup = setupMouseTracking(term);
						connectPty(term, fitAddon!);
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

			term.attachCustomWheelEventHandler((e: WheelEvent) => {
				if (!term.hasMouseTracking()) return false;
				const [col, row] = cellCoords(e);
				sgrMouse(e.deltaY < 0 ? 64 : 65, col, row, true);
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
			ws = new WebSocket(ptyUrl);
			wsRef.current = ws;

			ws.onopen = () => {
				const dims = fit.proposeDimensions();
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

			ws.onclose = () => {
				term.writeln("\r\n\x1b[2m[session ended]\x1b[0m");
			};

			ws.onerror = () => {
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

		setup();

		return () => {
			disposed = true;
			layoutObserver?.disconnect();
			mouseCleanup?.();
			ws?.close();
			wsRef.current = null;
			fitAddon?.dispose();
			if (termRef.current) {
				termRef.current.dispose();
				termRef.current = null;
			}
		};
	}, [ptyUrl, taskId]);

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
				const resolved = await api.request.resolveFilename({ filename: f.name });
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

	return (
		<div
			ref={containerRef}
			className="w-full h-full min-h-0"
			style={{ padding: "4px" }}
			onClick={() => termRef.current?.focus()}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		/>
	);
}

export default TerminalView;
