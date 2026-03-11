import { useState, useCallback } from "react";
import type { TerminalHandle } from "../TerminalView";

interface ExtraKeyBarProps {
	handle: TerminalHandle;
}

/**
 * Extra key bar for mobile terminal access — provides keys
 * that are missing or hard to reach on mobile keyboards:
 * Esc, Tab, Ctrl (sticky modifier), arrows, and common shell chars.
 */
function ExtraKeyBar({ handle }: ExtraKeyBarProps) {
	const [ctrlActive, setCtrlActive] = useState(false);

	const send = useCallback((data: string) => {
		if (ctrlActive) {
			// Ctrl+<key>: send the control character
			// Only applies to single printable characters
			if (data.length === 1) {
				const code = data.toUpperCase().charCodeAt(0);
				if (code >= 64 && code <= 95) {
					handle.sendInput(String.fromCharCode(code - 64));
					setCtrlActive(false);
					handle.focus();
					return;
				}
			}
			setCtrlActive(false);
		}
		handle.sendInput(data);
		handle.focus();
	}, [handle, ctrlActive]);

	const toggleCtrl = useCallback(() => {
		setCtrlActive((prev) => !prev);
	}, []);

	const btnBase = "flex-shrink-0 flex items-center justify-center h-8 rounded text-xs font-medium transition-colors select-none";
	const btnNormal = `${btnBase} min-w-[2.25rem] px-1.5 bg-elevated text-fg-2 active:bg-elevated-hover`;
	const btnCtrl = `${btnBase} min-w-[2.25rem] px-1.5 ${ctrlActive ? "bg-accent text-white" : "bg-elevated text-fg-2 active:bg-elevated-hover"}`;
	const btnArrow = `${btnBase} w-8 bg-elevated text-fg-2 active:bg-elevated-hover`;

	return (
		<div className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 bg-base border-t border-edge overflow-x-auto">
			{/* Modifier keys */}
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b")}>Esc</button>
			<button className={btnCtrl} onMouseDown={(e) => e.preventDefault()} onClick={toggleCtrl}>Ctrl</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\t")}>Tab</button>

			{/* Separator */}
			<div className="w-px h-5 bg-edge mx-0.5" />

			{/* Arrow keys */}
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[A")}>{"\u25B2"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[B")}>{"\u25BC"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[D")}>{"\u25C0"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[C")}>{"\u25B6"}</button>

			{/* Separator */}
			<div className="w-px h-5 bg-edge mx-0.5" />

			{/* Common shell characters */}
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("|")}>|</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("~")}>~</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("-")}>-</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("/")}>/</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("`")}>`</button>
		</div>
	);
}

export default ExtraKeyBar;
