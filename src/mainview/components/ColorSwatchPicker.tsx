import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LABEL_COLORS } from "../../shared/types";
import { computeAnchoredPosition } from "../utils/popoverPosition";

const COLUMNS = 6;

interface ColorSwatchPickerProps {
	value: string;
	onChange: (color: string) => void;
	disabled?: boolean;
	/** Accessible name for the trigger, e.g. "Label color". */
	label: string;
}

/**
 * Current-colour dot that opens an anchored swatch grid. Replaces the inline
 * row of every palette entry, which multiplied to hundreds of dots on a board
 * with many labels.
 */
export default function ColorSwatchPicker({ value, onChange, disabled = false, label }: ColorSwatchPickerProps) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => {
		setOpen(false);
		setPos(null);
		triggerRef.current?.focus();
	}, []);

	useLayoutEffect(() => {
		if (!open || !triggerRef.current || !popoverRef.current) return;
		const rect = triggerRef.current.getBoundingClientRect();
		const next = computeAnchoredPosition(
			rect,
			{ width: popoverRef.current.offsetWidth, height: popoverRef.current.offsetHeight },
			{ placement: "bottom", align: "start" },
		);
		setPos({ top: next.top, left: next.left });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		function handlePointerDown(event: MouseEvent) {
			const target = event.target as Node;
			if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
			setOpen(false);
			setPos(null);
		}
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.stopPropagation();
				close();
			}
		}
		document.addEventListener("mousedown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown, true);
		return () => {
			document.removeEventListener("mousedown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown, true);
		};
	}, [open, close]);

	// Arrow keys walk the grid; the swatch under focus is the one Enter picks.
	function handleGridKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
		const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
		if (step === undefined) return;
		event.preventDefault();
		const next = index + step;
		if (next < 0 || next >= LABEL_COLORS.length) return;
		popoverRef.current?.querySelectorAll<HTMLButtonElement>("[data-swatch]")[next]?.focus();
	}

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				disabled={disabled}
				aria-label={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				className="flex-shrink-0 grid place-items-center w-7 h-7 rounded-lg outline-none transition-colors hover:bg-elevated focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40 disabled:cursor-default"
			>
				<span
					className="w-4 h-4 rounded-full border border-edge-active shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25)]"
					style={{ background: value }}
				/>
			</button>
			{open && createPortal(
				<div
					ref={popoverRef}
					role="dialog"
					aria-label={label}
					className="fixed z-50 p-2 bg-overlay border border-edge-active rounded-2xl shadow-2xl shadow-black/40 max-w-[calc(100vw-2rem)]"
					style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
				>
					<div className="grid grid-cols-6 gap-1">
						{LABEL_COLORS.map((color, index) => {
							const selected = color === value;
							return (
								<button
									key={color}
									data-swatch
									type="button"
									autoFocus={selected}
									aria-label={color}
									aria-pressed={selected}
									onKeyDown={(event) => handleGridKeyDown(event, index)}
									onClick={() => {
										onChange(color);
										close();
									}}
									className="grid place-items-center w-8 h-8 rounded-xl outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated"
								>
									<span
										className={`w-4 h-4 rounded-full transition-transform ${selected ? "scale-125 ring-2 ring-fg/50" : ""}`}
										style={{ background: color }}
									/>
								</button>
							);
						})}
					</div>
				</div>,
				document.body,
			)}
		</>
	);
}
