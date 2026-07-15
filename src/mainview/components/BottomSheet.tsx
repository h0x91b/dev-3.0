import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useBackLayer } from "../hooks/useBackLayer";

interface BottomSheetProps {
	open: boolean;
	onClose: () => void;
	/** Visible header title. When omitted, no header row is rendered (pass `ariaLabel`). */
	title?: string;
	/** Accessible name when there is no visible `title`. */
	ariaLabel?: string;
	children: ReactNode;
	testId?: string;
}

/**
 * Narrow-viewport primitive: a panel that slides up from the bottom edge.
 *
 * The mandated mobile container for content that does not fit a phone-width
 * surface — filters, "move to", context-menu actions, file pickers, etc. Built
 * as pure React (no native dialog) so it works identically in the Electrobun
 * desktop shell and in headless remote (browser) mode.
 *
 * Dismisses on backdrop tap, the close button, Esc, or a swipe-down on the
 * header. Traps and restores focus, respects `env(safe-area-inset-bottom)`, and
 * honours `prefers-reduced-motion` (the slide-in animation is CSS-driven and
 * disabled under reduced motion — see `.bottom-sheet-panel` in index.css).
 */
export default function BottomSheet(props: BottomSheetProps) {
	// No hooks here so the conditional return is safe; the inner component owns
	// all hooks and mounts/unmounts with `open` (lets useFocusTrap capture the
	// trigger and restore focus on close).
	if (!props.open) return null;
	return <Sheet {...props} />;
}

function Sheet({ onClose, title, ariaLabel, children, testId }: BottomSheetProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [dragY, setDragY] = useState(0);
	const startY = useRef<number | null>(null);

	// Android hardware Back closes the sheet (mobile remote mode).
	useBackLayer(onClose);

	// Esc closes (capture phase so it wins over background handlers).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		}
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	function onTouchStart(e: React.TouchEvent) {
		startY.current = e.touches[0]?.clientY ?? null;
	}
	function onTouchMove(e: React.TouchEvent) {
		if (startY.current == null) return;
		const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
		setDragY(dy > 0 ? dy : 0);
	}
	function onTouchEnd() {
		if (dragY > 80) onClose();
		setDragY(0);
		startY.current = null;
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			data-testid={testId}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel ?? title}
				tabIndex={-1}
				data-bottom-sheet
				className="bottom-sheet-panel w-full max-w-[40rem] bg-overlay border-t border-edge rounded-t-2xl shadow-2xl max-h-[85dvh] overflow-y-auto outline-none"
				style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
			>
				{/* Grabber + header: also the swipe-down dismiss surface. */}
				<div
					className="sticky top-0 z-10 bg-overlay pt-2"
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
				>
					<div className="mx-auto mb-2 h-1 w-10 rounded-full bg-edge-active/60" aria-hidden="true" />
					{title && (
						<div className="flex items-center justify-between border-b border-edge/60 px-4 pb-2">
							<h2 className="text-fg text-sm font-semibold">{title}</h2>
							<button
								type="button"
								onClick={onClose}
								aria-label={t("common.close")}
								className="-mr-1.5 flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted hover:bg-elevated hover:text-fg transition-colors"
							>
								<span className="text-base leading-none">×</span>
							</button>
						</div>
					)}
				</div>
				<div
					className="px-4 py-3"
					style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
				>
					{children}
				</div>
			</div>
		</div>,
		document.body,
	);
}
