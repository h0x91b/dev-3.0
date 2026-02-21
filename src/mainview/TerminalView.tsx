import { useEffect, useRef } from "react";
import { Terminal, FitAddon } from "ghostty-web";

interface TerminalViewProps {
	ptyUrl: string;
	taskId: string;
}

function TerminalView({ ptyUrl, taskId }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);

	useEffect(() => {
		let disposed = false;
		let fitAddon: FitAddon | null = null;
		let ws: WebSocket | null = null;
		let layoutObserver: ResizeObserver | null = null;

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
						connectPty(term, fitAddon!);
					});
				}
			});
			layoutObserver.observe(containerRef.current);
		}

		function connectPty(term: Terminal, fit: FitAddon) {
			ws = new WebSocket(ptyUrl);

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
				term.write(
					typeof event.data === "string"
						? event.data
						: new Uint8Array(event.data),
				);
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
			ws?.close();
			fitAddon?.dispose();
			if (termRef.current) {
				termRef.current.dispose();
				termRef.current = null;
			}
		};
	}, [ptyUrl, taskId]);

	return (
		<div
			ref={containerRef}
			className="w-full h-full min-h-0"
			style={{ padding: "4px" }}
			onClick={() => termRef.current?.focus()}
		/>
	);
}

export default TerminalView;
