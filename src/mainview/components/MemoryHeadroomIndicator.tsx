import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SystemMemorySnapshot } from "../../shared/types";
import type { Route } from "../state";
import { api } from "../rpc";
import { useT } from "../i18n";
import { formatBytes, formatBytesCompact } from "../utils/formatBytes";
import { computeAnchoredPosition } from "../utils/popoverPosition";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
import MemoryBreakdownPanel, { PRESSURE_BAR_CLASS, PRESSURE_TEXT_CLASS } from "./MemoryBreakdownPanel";

/**
 * Ambient memory-headroom readout for the global header.
 *
 * Shows what is LEFT, not what is used: "12 GB" answers "can I start another
 * task?" directly, where "52 / 64" makes the reader do the subtraction. The
 * wording is load-bearing — a bare quantity labelled only "memory" reproduces the
 * exact ambiguity this widget exists to dissolve, so the accessible name and
 * tooltip both say *free*.
 *
 * There is deliberately no icon. A drawn memory module was tried first and failed
 * at 18 px: board, chips, contact teeth and notch all collapse into one grey
 * smudge that reads as a cassette. The number carries the meaning and a bar the
 * full width of the pill carries the level, which is the one thing that cannot
 * lose detail at this size.
 *
 * Colour comes from the operating system's own pressure verdict, never from a
 * percentage threshold of our own, so it stays meaningful on an 8 GB laptop and
 * on a 512 GB workstation alike. Length comes from the number. Those two are kept
 * separate on purpose: the bar can say "nearly full" while the colour still says
 * "the OS is fine with it", which on a 128 GB machine is the truth.
 *
 * On narrow it folds into the header kebab sheet alongside prevent-sleep and the
 * rate limits (PRODUCT_UX_BIBLE §12.6), and its breakdown opens as a BottomSheet:
 * there is no hover on touch and a floating popover would overflow a phone.
 */

/** Hover-out grace so the pointer can travel from pill to popover. */
const CLOSE_DELAY_MS = 120;
const POPOVER_WIDTH = 26 * 16;

interface MemoryHeadroomIndicatorProps {
	navigate: (route: Route) => void;
}

export default function MemoryHeadroomIndicator({ navigate }: MemoryHeadroomIndicatorProps) {
	const t = useT();
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const [snapshot, setSnapshot] = useState<SystemMemorySnapshot | null>(null);
	const [open, setOpen] = useState(false);
	/**
	 * Hover opens; a click PINS it open. Without the distinction a click on a
	 * pointer device closes the popover the same gesture's hover just opened
	 * (the pointer-over fires first), so the panel could never be clicked into.
	 * Pinned means hover-out no longer closes it, and the next click does.
	 */
	const [pinned, setPinned] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const popRef = useRef<HTMLDivElement | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.request
			.getSystemMemory()
			.then((result) => {
				if (!cancelled) setSnapshot(result);
			})
			.catch(() => {
				// No snapshot yet (first poll pending) — the widget stays hidden.
			});

		function onUpdate(e: Event) {
			setSnapshot((e as CustomEvent).detail as SystemMemorySnapshot);
		}
		window.addEventListener("rpc:systemMemoryUpdated", onUpdate);
		return () => {
			cancelled = true;
			window.removeEventListener("rpc:systemMemoryUpdated", onUpdate);
		};
	}, []);

	const cancelClose = useCallback(() => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);

	const close = useCallback(() => {
		cancelClose();
		setOpen(false);
		setPinned(false);
		setPos(null);
	}, [cancelClose]);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setOpen((wasOpen) => (pinned ? wasOpen : false));
			if (!pinned) setPos(null);
		}, CLOSE_DELAY_MS);
	}, [cancelClose, pinned]);

	useEffect(() => cancelClose, [cancelClose]);

	// Position the popover once it has a measurable size.
	useLayoutEffect(() => {
		if (isNarrow || !open || !anchorRef.current || !popRef.current) return;
		const anchor = anchorRef.current.getBoundingClientRect();
		const rect = popRef.current.getBoundingClientRect();
		const { top, left } = computeAnchoredPosition(
			anchor,
			{ width: rect.width, height: rect.height },
			{ placement: "bottom", align: "end" },
		);
		setPos({ top, left });
	}, [open, isNarrow, snapshot]);

	// Escape closes and hands focus back to the trigger.
	useEffect(() => {
		if (!open || isNarrow) return;
		function onKey(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			close();
			anchorRef.current?.focus();
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, isNarrow, close]);

	// A pinned popover no longer closes on hover-out, so it needs the usual
	// outside-click dismissal (same pattern as SiblingPopover).
	useEffect(() => {
		if (!pinned || isNarrow) return;
		function onMouseDown(e: MouseEvent) {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target) || popRef.current?.contains(target)) return;
			close();
		}
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [pinned, isNarrow, close]);

	const selectTask = useCallback(
		(taskId: string, projectId: string) => {
			close();
			navigate({ screen: "project", projectId, activeTaskId: taskId });
		},
		[close, navigate],
	);

	// Render nothing until the first snapshot lands: a placeholder pill would
	// cause exactly the header layout shift the UX manifest warns about.
	if (!snapshot) return null;

	const usedRatio = snapshot.total > 0 ? snapshot.used / snapshot.total : 0;
	const pressureClass = PRESSURE_TEXT_CLASS[snapshot.pressure];
	const accessibleName = t("memory.ariaLabel", { free: formatBytes(snapshot.headroom) });

	const breakdown = <MemoryBreakdownPanel snapshot={snapshot} onSelectTask={selectTask} />;

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				onClick={() => {
					if (pinned) {
						close();
						return;
					}
					cancelClose();
					setOpen(true);
					setPinned(true);
				}}
				onMouseEnter={isNarrow ? undefined : () => { cancelClose(); setOpen(true); }}
				onMouseLeave={isNarrow ? undefined : scheduleClose}
				onFocus={(e) => {
					if (!isNarrow && e.target.matches(":focus-visible")) setOpen(true);
				}}
				aria-label={accessibleName}
				aria-expanded={open}
				aria-haspopup="dialog"
				data-help-id="header.memory"
				data-testid="memory-headroom-indicator"
				className={`header-anim flex shrink-0 flex-col justify-center gap-[0.1875rem] rounded-lg transition-colors hover:bg-elevated ${
					isNarrow ? "h-11 px-2" : "px-1.5 py-1"
				} ${pressureClass}`}
			>
				<span className="text-micro font-medium leading-none tabular-nums">
					{formatBytesCompact(snapshot.headroom)}
				</span>
				{/* The level lives in a bar under the number, not in a glyph: at header
				    size a drawn memory module loses the detail that made it readable,
				    while a bar the full width of the pill cannot lose anything. */}
				<span aria-hidden="true" className="h-0.5 w-full overflow-hidden rounded-full bg-edge">
					<span
						className={`hdr-mem-bar block h-full rounded-full ${PRESSURE_BAR_CLASS[snapshot.pressure]}`}
						style={{ width: `${Math.round(Math.min(1, Math.max(0, usedRatio)) * 100)}%` }}
					/>
				</span>
			</button>

			{isNarrow ? (
				<BottomSheet open={open} onClose={close} title={t("memory.label")} testId="memory-breakdown-sheet">
					{breakdown}
				</BottomSheet>
			) : (
				open &&
				createPortal(
					<div
						ref={popRef}
						role="dialog"
						aria-label={t("memory.label")}
						onMouseEnter={cancelClose}
						onMouseLeave={scheduleClose}
						data-testid="memory-breakdown-popover"
						className="fixed z-[1200] overflow-y-auto overflow-x-hidden rounded-xl border border-edge-active bg-overlay shadow-2xl shadow-black/40"
						style={{
							top: pos?.top ?? 0,
							left: pos?.left ?? 0,
							width: POPOVER_WIDTH,
							maxWidth: "calc(100vw - 2rem)",
							maxHeight: "28rem",
							visibility: pos ? "visible" : "hidden",
						}}
					>
						{breakdown}
					</div>,
					document.body,
				)
			)}
		</>
	);
}
