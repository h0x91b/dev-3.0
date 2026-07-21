import { useState, useCallback, useRef } from "react";
import type { TerminalHandle } from "../TerminalView";
import { useT } from "../i18n";
import { useAttachUpload } from "../hooks/useAttachUpload";

interface ExtraKeyBarProps {
	handle: TerminalHandle;
	/** Raw input mode: taps focus the terminal directly (OSK types into the PTY). */
	rawMode?: boolean;
	/** Present when the host supports the compose/raw switch — renders the ⌨ toggle. */
	onToggleRaw?: () => void;
	/** Project that owns the worktree uploads dir — enables the attach button. */
	attachProjectId?: string;
	/** Task context for upload-error toasts. */
	attachTaskId?: string;
	/** Receives raw uploaded paths; the host routes them (composer draft / PTY). */
	onAttachPaths?: (paths: string[]) => void;
}

/**
 * Extra key bar for mobile terminal access — provides keys
 * that are missing or hard to reach on mobile keyboards:
 * Esc, Enter, Backspace, arrows, Tab, Shift+Tab (agent-mode cycling in Claude
 * Code), Ctrl (sticky modifier), and common shell chars.
 * The leading ⌨ button (when the host wires onToggleRaw) switches between
 * compose mode (default — TerminalComposer owns text entry) and raw mode
 * (direct typing into the terminal).
 *
 * Sizing uses `vw` units so buttons scale to actual screen width
 * regardless of the CSS viewport used in browser mode.
 * 11vw ≈ 43px physical on a 390px-wide phone.
 */
function ExtraKeyBar({ handle, rawMode, onToggleRaw, attachProjectId, attachTaskId, onAttachPaths }: ExtraKeyBarProps) {
	const t = useT();
	const [ctrlActive, setCtrlActive] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { uploading, attach } = useAttachUpload(attachProjectId, attachTaskId);

	function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
		const files = Array.from(e.target.files ?? []);
		// Reset so picking the same file again re-fires onChange.
		e.target.value = "";
		void attach(files).then((paths) => {
			if (paths.length) onAttachPaths?.(paths);
		});
	}

	// Focus discipline: only re-focus the terminal in raw mode. In compose mode
	// the composer textarea may hold focus (and the OSK) — stealing it here would
	// retarget the keyboard at the hidden terminal textarea. The buttons'
	// mousedown-preventDefault already keeps the current focus untouched.
	const refocus = useCallback(() => {
		if (rawMode) handle.focus();
	}, [handle, rawMode]);

	const send = useCallback((data: string) => {
		if (ctrlActive) {
			if (data.length === 1) {
				const code = data.toUpperCase().charCodeAt(0);
				if (code >= 64 && code <= 95) {
					handle.sendInput(String.fromCharCode(code - 64));
					setCtrlActive(false);
					refocus();
					return;
				}
			}
			setCtrlActive(false);
		}
		handle.sendInput(data);
		refocus();
	}, [handle, ctrlActive, refocus]);

	const toggleCtrl = useCallback(() => {
		setCtrlActive((prev) => !prev);
		refocus();
	}, [refocus]);

	// All sizes in vw so they map to real physical screen pixels.
	const btnBase = "flex-shrink-0 flex items-center justify-center rounded-[1vw] font-semibold select-none active:opacity-70 transition-opacity";
	const btnStyle = "h-[11vw] min-w-[14vw] px-[2vw] text-[4vw]";
	const btnNormal = `${btnBase} ${btnStyle} bg-elevated text-fg-2`;
	const btnCtrl = `${btnBase} ${btnStyle} ${ctrlActive ? "bg-accent text-white" : "bg-elevated text-fg-2"}`;
	const btnRaw = `${btnBase} h-[11vw] min-w-[12vw] px-[2vw] text-[4.5vw] ${rawMode ? "bg-accent text-white" : "bg-elevated text-fg-2"}`;
	const btnArrow = `${btnBase} h-[11vw] w-[11vw] text-[3.5vw] bg-elevated text-fg-2`;

	return (
		<div className="flex-shrink-0 flex items-center gap-[1vw] px-[2vw] py-[1.5vw] bg-base border-t border-edge overflow-x-auto">
			{onToggleRaw && (
				<>
					<button
						className={btnRaw}
						onMouseDown={(e) => e.preventDefault()}
						onClick={onToggleRaw}
						aria-label={t("terminal.rawKeyboard")}
						aria-pressed={!!rawMode}
						title={t("terminal.rawKeyboard")}
						data-testid="extra-key-raw-toggle"
					>
						<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F030C}"}</span>
					</button>
					<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />
				</>
			)}

			{attachProjectId && onAttachPaths && (
				<>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="hidden"
						onChange={onFilesPicked}
						data-testid="extra-key-attach-input"
					/>
					<button
						className={btnNormal}
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => fileInputRef.current?.click()}
						disabled={uploading}
						aria-label={t("images.attachFiles")}
						title={t("images.attachFiles")}
						data-testid="extra-key-attach"
					>
						{uploading ? (
							<div className="w-[4vw] h-[4vw] border-2 border-fg-muted/30 border-t-accent rounded-full animate-spin" />
						) : (
							<span style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F03E2}"}</span>
						)}
					</button>
					<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />
				</>
			)}

			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b")}>Esc</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\r")}>Enter</button>

			<button
				className={btnNormal}
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => send("\x7f")}
				aria-label={t("terminal.backspace")}
				title={t("terminal.backspace")}
				data-testid="extra-key-backspace"
			>
				{"⌫"}
			</button>

			<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />

			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[A")}>{"▲"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[B")}>{"▼"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[D")}>{"◀"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[C")}>{"▶"}</button>

			<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />

			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\t")}>Tab</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[Z")}>{"⇧Tab"}</button>
			<button className={btnCtrl} onMouseDown={(e) => e.preventDefault()} onClick={toggleCtrl}>Ctrl</button>

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
