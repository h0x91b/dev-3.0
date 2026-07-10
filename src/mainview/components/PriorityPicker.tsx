import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ALL_PRIORITIES, DEFAULT_PRIORITY, type TaskPriority } from "../../shared/types";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useT } from "../i18n";
import { PRIORITY_NAME_KEYS, PRIORITY_STYLES } from "./priorityStyles";

interface PriorityPickerProps {
	/** Currently-selected priority (undefined ⇒ default). */
	selected: TaskPriority | undefined;
	onSelect: (priority: TaskPriority) => void;
	onClose: () => void;
	anchorEl: HTMLElement;
}

/**
 * Anchored popover for choosing one of the five priority levels. Portal-rendered
 * (never clipped by a card), viewport-clamped, closes on Esc / click-outside, and
 * keeps focus operable (arrow keys move between the radio rows). Positioning
 * mirrors {@link LabelPicker}.
 */
function PriorityPicker({ selected, onSelect, onClose, anchorEl }: PriorityPickerProps) {
	const t = useT();
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const pickerRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const current = selected ?? DEFAULT_PRIORITY;

	useLayoutEffect(() => {
		if (!pickerRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const picker = pickerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = anchor.bottom + 4;
		let left = anchor.left;
		if (top + picker.height > vh - pad) top = anchor.top - picker.height - 4;
		if (left + picker.width > vw - pad) left = vw - picker.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
		// Land focus on the current level so keyboard users start where they are.
		const idx = ALL_PRIORITIES.indexOf(current);
		rowRefs.current[idx >= 0 ? idx : 0]?.focus();
	}, [anchorEl, current]);

	useEscapeKey(onClose);

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (
				pickerRef.current &&
				!pickerRef.current.contains(e.target as Node) &&
				!anchorEl.contains(e.target as Node)
			) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [anchorEl, onClose]);

	function handleKeyDown(e: React.KeyboardEvent, index: number) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const next = e.key === "ArrowDown"
				? (index + 1) % ALL_PRIORITIES.length
				: (index - 1 + ALL_PRIORITIES.length) % ALL_PRIORITIES.length;
			rowRefs.current[next]?.focus();
		}
	}

	return createPortal(
		<div
			ref={pickerRef}
			role="menu"
			aria-label={t("priority.pickerTitle")}
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active overflow-hidden py-1 max-w-[calc(100vw-1rem)]"
			style={{ top: pos.top, left: pos.left, width: 200, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			{ALL_PRIORITIES.map((level, index) => {
				const style = PRIORITY_STYLES[level];
				const isOn = level === current;
				return (
					<button
						key={level}
						ref={(el) => { rowRefs.current[index] = el; }}
						type="button"
						role="menuitemradio"
						aria-checked={isOn}
						onClick={() => onSelect(level)}
						onKeyDown={(e) => handleKeyDown(e, index)}
						className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors outline-none hover:bg-elevated-hover focus:bg-elevated-hover ${isOn ? "bg-elevated" : ""}`}
					>
						<span className={`font-mono text-[0.6875rem] font-semibold px-1.5 py-0.5 rounded ${style.badge}`}>
							{level}
						</span>
						<span className="text-xs text-fg flex-1 truncate">{t(PRIORITY_NAME_KEYS[level])}</span>
						{isOn && (
							<svg className="w-3.5 h-3.5 flex-shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
								<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
							</svg>
						)}
					</button>
				);
			})}
		</div>,
		document.body,
	);
}

export default PriorityPicker;
