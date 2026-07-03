import {
	cloneElement,
	isValidElement,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
	type Ref,
	type RefCallback,
} from "react";
import { createPortal } from "react-dom";
import { computeAnchoredPosition, type PopoverPlacement } from "../utils/popoverPosition";

/**
 * Fast styled replacement for the native `title=` attribute.
 *
 * Native tooltips carry an OS-controlled ~1.5s delay, cannot be styled, and
 * look foreign in both themes. This primitive shows after a short hover-intent
 * delay (instantly when another tooltip was visible a moment ago — the "grace
 * period" that makes scanning a toolbar feel instant), positions itself with
 * the shared popover util, and renders app-styled content with an optional
 * keyboard-shortcut chip.
 *
 * Usage — wrap exactly one element; do NOT also keep a `title=` on it:
 *
 *   <Tooltip content={t("task.watchTooltip")} kbd="⌘W">
 *     <button …/>
 *   </Tooltip>
 *
 * The child is cloned (no wrapper node, layout untouched). Also shows on
 * keyboard focus for accessibility, and wires `aria-describedby` while open.
 */

const SHOW_DELAY_MS = 250;
/** After hiding, a new tooltip within this window skips the intent delay. */
const GRACE_MS = 400;

// Module-level so the grace period spans sibling tooltips in a toolbar.
let lastHiddenAt = 0;

interface TooltipProps {
	content: ReactNode;
	/** Optional keyboard-shortcut chip rendered after the text, e.g. "⌘K". */
	kbd?: string;
	placement?: PopoverPlacement;
	/** Render children without any tooltip (conditional escape hatch). */
	disabled?: boolean;
	children: ReactElement;
}

type ElementWithHandlers = ReactElement<{
	ref?: Ref<HTMLElement>;
	onMouseEnter?: (e: React.MouseEvent) => void;
	onMouseLeave?: (e: React.MouseEvent) => void;
	onMouseDown?: (e: React.MouseEvent) => void;
	onFocus?: (e: React.FocusEvent) => void;
	onBlur?: (e: React.FocusEvent) => void;
	"aria-describedby"?: string;
}>;

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
	return (value) => {
		for (const ref of refs) {
			if (!ref) continue;
			if (typeof ref === "function") ref(value);
			else (ref as { current: T | null }).current = value;
		}
	};
}

export default function Tooltip({ content, kbd, placement = "top", disabled, children }: TooltipProps) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const anchorRef = useRef<HTMLElement | null>(null);
	const popRef = useRef<HTMLDivElement | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tooltipId = useId();

	const cancelTimer = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const hide = useCallback(() => {
		cancelTimer();
		setOpen((wasOpen) => {
			if (wasOpen) lastHiddenAt = Date.now();
			return false;
		});
		setPos(null);
	}, [cancelTimer]);

	const show = useCallback(() => {
		cancelTimer();
		setOpen(true);
	}, [cancelTimer]);

	const scheduleShow = useCallback(() => {
		cancelTimer();
		if (Date.now() - lastHiddenAt < GRACE_MS) {
			setOpen(true);
			return;
		}
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			setOpen(true);
		}, SHOW_DELAY_MS);
	}, [cancelTimer]);

	useEffect(() => cancelTimer, [cancelTimer]);

	// Position once the popup has a size.
	useLayoutEffect(() => {
		if (!open || !anchorRef.current || !popRef.current) return;
		const anchor = anchorRef.current.getBoundingClientRect();
		const popRect = popRef.current.getBoundingClientRect();
		const { top, left } = computeAnchoredPosition(
			anchor,
			{ width: popRect.width, height: popRect.height },
			{ placement, align: "center" },
		);
		setPos({ top, left });
	}, [open, placement]);

	// Any scroll or Escape dismisses (the anchor may move under the tooltip).
	useEffect(() => {
		if (!open) return;
		const onScroll = () => hide();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") hide();
		};
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [open, hide]);

	if (!isValidElement(children)) return children;
	if (disabled) return children;

	const child = children as ElementWithHandlers;
	const childProps = child.props;

	const cloned = cloneElement(child, {
		ref: mergeRefs<HTMLElement>(
			(childProps.ref as Ref<HTMLElement> | undefined) ?? undefined,
			(node) => {
				anchorRef.current = node;
			},
		),
		onMouseEnter: (e: React.MouseEvent) => {
			childProps.onMouseEnter?.(e);
			scheduleShow();
		},
		onMouseLeave: (e: React.MouseEvent) => {
			childProps.onMouseLeave?.(e);
			hide();
		},
		onMouseDown: (e: React.MouseEvent) => {
			childProps.onMouseDown?.(e);
			hide();
		},
		onFocus: (e: React.FocusEvent) => {
			childProps.onFocus?.(e);
			// Keyboard focus shows immediately — there is no "intent" to wait for.
			if (e.target.matches(":focus-visible")) show();
		},
		onBlur: (e: React.FocusEvent) => {
			childProps.onBlur?.(e);
			hide();
		},
		"aria-describedby": open
			? [childProps["aria-describedby"], tooltipId].filter(Boolean).join(" ")
			: childProps["aria-describedby"],
	});

	return (
		<>
			{cloned}
			{open
				? createPortal(
						<div
							ref={popRef}
							id={tooltipId}
							role="tooltip"
							className="fixed z-[1200] pointer-events-none bg-overlay border border-edge-active rounded-lg shadow-xl shadow-black/30 px-2.5 py-1.5 text-xs text-fg-2 max-w-[18rem] flex items-center gap-2"
							style={{
								top: pos?.top ?? 0,
								left: pos?.left ?? 0,
								visibility: pos ? "visible" : "hidden",
							}}
						>
							<span className="min-w-0">{content}</span>
							{kbd ? (
								<kbd className="flex-shrink-0 font-mono text-[0.625rem] text-fg-3 bg-raised border border-edge rounded px-1 py-px">
									{kbd}
								</kbd>
							) : null}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
