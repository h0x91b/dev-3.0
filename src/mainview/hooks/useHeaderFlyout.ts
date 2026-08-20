import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, RefObject } from "react";
import { computeAnchoredPosition } from "../utils/popoverPosition";
import { computeMenuFlyoutPosition, MENU_FLYOUT_CLOSE_MS, MENU_FLYOUT_HOVER_MS } from "../utils/menuFlyout";

/**
 * The open/pin/position machinery behind an ambient header readout.
 *
 * Every such readout (memory headroom, remote connection quality) has the same
 * two homes and the same behaviour in each: a header pill that drops its panel
 * below itself and opens on hover immediately, and a labelled row in the header
 * kebab that hangs its panel off the menu's outboard edge and opens only after a
 * hover dwell, so a pointer travelling down the menu does not fire it.
 *
 * Hover opens; a click PINS. Without that distinction a click on a pointer
 * device closes the panel the same gesture's hover just opened (pointer-over
 * fires first), so the panel could never be clicked into. Pinned means hover-out
 * no longer closes it, and the next click does.
 */

/** Hover-out grace so the pointer can travel from the trigger to its panel. */
const CLOSE_DELAY_MS = 120;

export type HeaderFlyoutVariant = "bar" | "menu";

export interface HeaderFlyoutOptions {
	variant: HeaderFlyoutVariant;
	/** On narrow the panel is a BottomSheet, so hover and positioning are off. */
	isNarrow: boolean;
	/**
	 * Anything whose change can resize the panel. The panel is measured after it
	 * mounts, so a resize has to re-run the positioning.
	 */
	repositionKey?: unknown;
}

export interface HeaderFlyout {
	open: boolean;
	pinned: boolean;
	pos: { top: number; left: number } | null;
	anchorRef: RefObject<HTMLButtonElement | null>;
	popRef: RefObject<HTMLDivElement | null>;
	close: () => void;
	/** Spread onto the trigger button. */
	triggerProps: {
		onClick: () => void;
		onMouseEnter: (() => void) | undefined;
		onMouseLeave: (() => void) | undefined;
		onFocus: (e: FocusEvent<HTMLButtonElement>) => void;
		"aria-expanded": boolean;
		"aria-haspopup": "dialog";
	};
	/** Spread onto the portaled panel. */
	panelProps: {
		onMouseEnter: () => void;
		onMouseLeave: () => void;
	};
}

export function useHeaderFlyout({ variant, isNarrow, repositionKey }: HeaderFlyoutOptions): HeaderFlyout {
	const [open, setOpen] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const popRef = useRef<HTMLDivElement | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelClose = useCallback(() => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);

	const cancelOpen = useCallback(() => {
		if (openTimer.current !== null) {
			clearTimeout(openTimer.current);
			openTimer.current = null;
		}
	}, []);

	const close = useCallback(() => {
		cancelClose();
		cancelOpen();
		setOpen(false);
		setPinned(false);
		setPos(null);
	}, [cancelClose, cancelOpen]);

	const scheduleClose = useCallback(() => {
		cancelClose();
		cancelOpen();
		closeTimer.current = setTimeout(
			() => {
				closeTimer.current = null;
				setOpen((wasOpen) => (pinned ? wasOpen : false));
				if (!pinned) setPos(null);
			},
			variant === "menu" ? MENU_FLYOUT_CLOSE_MS : CLOSE_DELAY_MS,
		);
	}, [cancelClose, cancelOpen, pinned, variant]);

	/** Hover intent for the menu row: a pointer merely passing by must not open it. */
	const scheduleOpen = useCallback(() => {
		cancelClose();
		cancelOpen();
		if (variant === "bar") {
			setOpen(true);
			return;
		}
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			setOpen(true);
		}, MENU_FLYOUT_HOVER_MS);
	}, [cancelClose, cancelOpen, variant]);

	useEffect(
		() => () => {
			cancelClose();
			cancelOpen();
		},
		[cancelClose, cancelOpen],
	);

	// Position once the panel has a measurable size. The menu row hangs its flyout
	// off the menu's outboard edge; the header pill drops it below itself.
	useLayoutEffect(() => {
		if (isNarrow || !open || !anchorRef.current || !popRef.current) return;
		const rect = popRef.current.getBoundingClientRect();
		const size = { width: rect.width, height: rect.height };
		if (variant === "menu") {
			setPos(computeMenuFlyoutPosition(anchorRef.current, size));
			return;
		}
		const { top, left } = computeAnchoredPosition(anchorRef.current.getBoundingClientRect(), size, {
			placement: "bottom",
			align: "end",
		});
		setPos({ top, left });
	}, [open, isNarrow, variant, repositionKey]);

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

	// A pinned panel no longer closes on hover-out, so it needs the usual
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

	const togglePinned = useCallback(() => {
		if (pinned) {
			close();
			return;
		}
		cancelClose();
		setOpen(true);
		setPinned(true);
	}, [cancelClose, close, pinned]);

	return {
		open,
		pinned,
		pos,
		anchorRef,
		popRef,
		close,
		triggerProps: {
			onClick: togglePinned,
			onMouseEnter: isNarrow ? undefined : scheduleOpen,
			onMouseLeave: isNarrow ? undefined : scheduleClose,
			onFocus: (e: FocusEvent<HTMLButtonElement>) => {
				if (!isNarrow && e.target.matches(":focus-visible")) setOpen(true);
			},
			"aria-expanded": open,
			"aria-haspopup": "dialog",
		},
		panelProps: {
			onMouseEnter: cancelClose,
			onMouseLeave: scheduleClose,
		},
	};
}
