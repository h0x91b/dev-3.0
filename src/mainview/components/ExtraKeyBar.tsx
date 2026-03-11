import { useState, useCallback } from "react";
import type { TerminalHandle } from "../TerminalView";

interface ExtraKeyBarProps {
	handle: TerminalHandle;
}

/**
 * Extra key bar for mobile terminal access — provides keys
 * that are missing or hard to reach on mobile keyboards:
 * Esc, Tab, Ctrl (sticky modifier), arrows, and common shell chars.
 *
 * Sizing uses `vw` units so buttons scale to actual screen width
 * regardless of the 1024px CSS viewport used in browser mode.
 * 11vw ≈ 43px physical on a 390px-wide phone.
 */
function ExtraKeyBar({ handle }: ExtraKeyBarProps) {
	const [ctrlActive, setCtrlActive] = useState(false);

	const send = useCallback((data: string) => {
		if (ctrlActive) {
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
		handle.focus();
	}, [handle]);

	// All sizes in vw so they map to real physical screen pixels.
	// With width=1024 viewport on ~390px phone: 1vw ≈ 3.9px physical.
	const btnBase = "flex-shrink-0 flex items-center justify-center rounded-[1vw] font-semibold select-none active:opacity-70 transition-opacity";
	const btnStyle = "h-[11vw] min-w-[14vw] px-[2vw] text-[4vw]";
	const btnNormal = `${btnBase} ${btnStyle} bg-elevated text-fg-2`;
	const btnCtrl = `${btnBase} ${btnStyle} ${ctrlActive ? "bg-accent text-white" : "bg-elevated text-fg-2"}`;
	const btnArrow = `${btnBase} h-[11vw] w-[11vw] text-[3.5vw] bg-elevated text-fg-2`;

	return (
		<div className="flex-shrink-0 flex items-center gap-[1vw] px-[2vw] py-[1.5vw] bg-base border-t border-edge overflow-x-auto">
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b")}>Esc</button>
			<button className={btnCtrl} onMouseDown={(e) => e.preventDefault()} onClick={toggleCtrl}>Ctrl</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\t")}>Tab</button>

			<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />

			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[A")}>{"\u25B2"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[B")}>{"\u25BC"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[D")}>{"\u25C0"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[C")}>{"\u25B6"}</button>

			<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />

			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("|")}>|</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("~")}>~</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("-")}>-</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("/")}>/</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("`")}>`</button>
		</div>
	);
}

export default ExtraKeyBar;
