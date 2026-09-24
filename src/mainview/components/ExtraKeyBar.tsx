import { useState, useCallback, useRef, useEffect } from "react";
import type { TerminalHandle } from "../TerminalView";
import { useT } from "../i18n";
import { useAttachUpload } from "../hooks/useAttachUpload";
import { applyShiftToBarKey } from "../shift-key-sequences";

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

/** Hold-to-repeat timings, matching a typical OS key-repeat feel. */
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

interface Modifiers {
	ctrl: boolean;
	shift: boolean;
}

const NO_MODIFIERS: Modifiers = { ctrl: false, shift: false };

function applyModifiers(data: string, mods: Modifiers): string {
	if (mods.ctrl && data.length === 1) {
		const code = data.toUpperCase().charCodeAt(0);
		if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
	}
	return mods.shift ? applyShiftToBarKey(data) : data;
}

/**
 * Extra key bar for mobile terminal access — provides keys
 * that are missing or hard to reach on mobile keyboards:
 * Esc, Enter, Backspace, arrows, Tab, Shift+Tab (agent-mode cycling in Claude
 * Code), Ctrl and Shift (sticky one-shot modifiers — Shift+arrows reach Codex's
 * question stack), and common shell chars.
 * The leading ⌨ button (when the host wires onToggleRaw) switches between
 * compose mode (default — TerminalComposer owns text entry) and raw mode
 * (direct typing into the terminal).
 * Backspace and the arrows repeat while held, like a physical keyboard.
 *
 * Sizing uses `vw` units so buttons scale to actual screen width
 * regardless of the CSS viewport used in browser mode.
 * 11vw ≈ 43px physical on a 390px-wide phone.
 */
function ExtraKeyBar({ handle, rawMode, onToggleRaw, attachProjectId, attachTaskId, onAttachPaths }: ExtraKeyBarProps) {
	const t = useT();
	const [mods, setModsState] = useState<Modifiers>(NO_MODIFIERS);
	// Read at send time, so a hold-to-repeat timer never acts on a stale closure.
	const modsRef = useRef<Modifiers>(NO_MODIFIERS);
	const setMods = useCallback((next: Modifiers) => {
		modsRef.current = next;
		setModsState(next);
	}, []);
	// Modifiers latched when a repeating key goes down: every repeat and the final
	// tap of that press share them, instead of only the first emission.
	const press = useRef<{ data: string; mods: Modifiers } | null>(null);
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
		const latched = press.current?.data === data ? press.current.mods : null;
		press.current = null;
		const active = latched ?? modsRef.current;
		handle.sendInput(applyModifiers(data, active));
		if (modsRef.current.ctrl || modsRef.current.shift) setMods(NO_MODIFIERS);
		refocus();
	}, [handle, refocus, setMods]);

	// Hold-to-repeat: the tap itself is handled by onClick, so the timer only
	// emits the *extra* presses once the finger stays down past the delay.
	const repeat = useRef<{ delay?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval> }>({});

	const stopRepeat = useCallback(() => {
		if (repeat.current.delay) clearTimeout(repeat.current.delay);
		if (repeat.current.tick) clearInterval(repeat.current.tick);
		repeat.current = {};
	}, []);

	useEffect(() => stopRepeat, [stopRepeat]);

	const holdProps = useCallback((data: string) => ({
		onPointerDown: () => {
			stopRepeat();
			const latched = { data, mods: modsRef.current };
			press.current = latched;
			repeat.current.delay = setTimeout(() => {
				repeat.current.tick = setInterval(() => {
					handle.sendInput(applyModifiers(data, latched.mods));
					refocus();
				}, REPEAT_INTERVAL_MS);
			}, REPEAT_DELAY_MS);
		},
		onPointerUp: stopRepeat,
		onPointerLeave: stopRepeat,
		onPointerCancel: () => {
			stopRepeat();
			press.current = null;
		},
	}), [handle, refocus, stopRepeat]);

	const toggleModifier = useCallback((key: keyof Modifiers) => {
		setMods({ ...modsRef.current, [key]: !modsRef.current[key] });
		refocus();
	}, [refocus, setMods]);

	// All sizes in vw so they map to real physical screen pixels.
	const btnBase = "flex-shrink-0 flex items-center justify-center rounded-[1vw] font-semibold select-none active:opacity-70 transition-opacity";
	const btnStyle = "h-[11vw] min-w-[14vw] px-[2vw] text-[4vw]";
	const btnNormal = `${btnBase} ${btnStyle} bg-elevated text-fg-2`;
	const btnModifier = (active: boolean) => `${btnBase} ${btnStyle} ${active ? "bg-accent-fill text-white" : "bg-elevated text-fg-2"}`;
	const btnRaw = `${btnBase} h-[11vw] min-w-[12vw] px-[2vw] text-[4.5vw] ${rawMode ? "bg-accent-fill text-white" : "bg-elevated text-fg-2"}`;
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
				{...holdProps("\x7f")}
				aria-label={t("terminal.backspace")}
				title={t("terminal.backspace")}
				data-testid="extra-key-backspace"
			>
				{"⌫"}
			</button>

			<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />

			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[A")} {...holdProps("\x1b[A")}>{"▲"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[B")} {...holdProps("\x1b[B")}>{"▼"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[D")} {...holdProps("\x1b[D")}>{"◀"}</button>
			<button className={btnArrow} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[C")} {...holdProps("\x1b[C")}>{"▶"}</button>

			<div className="w-[0.25vw] h-[7vw] bg-edge mx-[0.5vw]" />

			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\t")}>Tab</button>
			<button className={btnNormal} onMouseDown={(e) => e.preventDefault()} onClick={() => send("\x1b[Z")}>{"⇧Tab"}</button>
			<button className={btnModifier(mods.ctrl)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleModifier("ctrl")} aria-pressed={mods.ctrl}>Ctrl</button>
			<button
				className={btnModifier(mods.shift)}
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => toggleModifier("shift")}
				aria-pressed={mods.shift}
				title={t("terminal.shiftModifierHint")}
				data-testid="extra-key-shift"
			>
				Shift
			</button>

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
