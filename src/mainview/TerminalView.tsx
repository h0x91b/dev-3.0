import { useEffect, useRef } from "react";
import { init, Terminal, FitAddon } from "ghostty-web";

function TerminalView() {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);

	useEffect(() => {
		let disposed = false;
		let fitAddon: FitAddon | null = null;

		async function setup() {
			if (!containerRef.current || disposed) return;

			await init();
			if (disposed) return;

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
			fitAddon.fit();
			fitAddon.observeResize();

			termRef.current = term;

			// Hello World banner
			term.writeln("\x1b[1;35m  ghostty-web \x1b[0m\x1b[2mv0.4.0\x1b[0m");
			term.writeln("");
			term.writeln(
				"\x1b[32m  Terminal emulator powered by Ghostty WASM\x1b[0m",
			);
			term.writeln(
				"\x1b[2m  Canvas renderer | VT100 | Kitty keyboard protocol\x1b[0m",
			);
			term.writeln("");

			// ANSI color palette demo
			let colors = "  ";
			for (let i = 0; i < 8; i++) colors += `\x1b[4${i}m   `;
			colors += "\x1b[0m\r\n  ";
			for (let i = 0; i < 8; i++) colors += `\x1b[10${i}m   `;
			colors += "\x1b[0m";
			term.writeln(colors);
			term.writeln("");

			// Simple local echo shell
			let line = "";
			const prompt = "\x1b[1;34m>\x1b[0m ";

			term.write(prompt);

			term.onData((data) => {
				if (data === "\r") {
					term.write("\r\n");
					handleCommand(term, line.trim());
					line = "";
					term.write(prompt);
				} else if (data === "\x7f" || data === "\b") {
					if (line.length > 0) {
						line = line.slice(0, -1);
						term.write("\b \b");
					}
				} else if (data === "\x03") {
					line = "";
					term.write("^C\r\n");
					term.write(prompt);
				} else if (data >= " ") {
					line += data;
					term.write(data);
				}
			});
		}

		setup();

		return () => {
			disposed = true;
			fitAddon?.dispose();
			if (termRef.current) {
				termRef.current.dispose();
				termRef.current = null;
			}
		};
	}, []);

	return (
		<div
			ref={containerRef}
			className="w-full h-full min-h-0"
			style={{ padding: "4px" }}
		/>
	);
}

function handleCommand(term: Terminal, cmd: string) {
	if (!cmd) return;

	switch (cmd) {
		case "help":
			term.writeln("\x1b[1mAvailable commands:\x1b[0m");
			term.writeln("  \x1b[33mhelp\x1b[0m     Show this message");
			term.writeln("  \x1b[33mhello\x1b[0m    Say hello");
			term.writeln("  \x1b[33mcolors\x1b[0m   Show 256-color palette");
			term.writeln("  \x1b[33mclear\x1b[0m    Clear screen");
			term.writeln("  \x1b[33mecho\x1b[0m     Echo arguments");
			break;

		case "hello":
			term.writeln("\x1b[1;36mHello, World!\x1b[0m");
			break;

		case "clear":
			term.clear();
			break;

		case "colors": {
			term.writeln("\x1b[1m256-color palette:\x1b[0m");
			for (let i = 0; i < 16; i++) {
				term.write(`\x1b[48;5;${i}m  `);
				if (i === 7) term.write("\x1b[0m\r\n");
			}
			term.writeln("\x1b[0m");
			for (let row = 0; row < 12; row++) {
				for (let col = 0; col < 18; col++) {
					const idx = 16 + row * 18 + col;
					if (idx < 232) term.write(`\x1b[48;5;${idx}m `);
				}
				term.writeln("\x1b[0m");
			}
			for (let i = 232; i < 256; i++) {
				term.write(`\x1b[48;5;${i}m `);
			}
			term.writeln("\x1b[0m");
			break;
		}

		default:
			if (cmd.startsWith("echo ")) {
				term.writeln(cmd.slice(5));
			} else {
				term.writeln(`\x1b[31mcommand not found:\x1b[0m ${cmd}`);
				term.writeln("\x1b[2mType 'help' for available commands\x1b[0m");
			}
	}
}

export default TerminalView;
