import { useCallback, useEffect, useRef, useState } from "react";
import { helpTopic } from "../help";
import type { PopoverPlacement } from "../utils/popoverPosition";
import { useT } from "../i18n";
import HelpCard, { type HelpCardContent } from "./HelpCard";

/**
 * Section-level (i) help button (bible §5.4). Allowed ONLY in surfaces that
 * already have a header/title row — max one per section; never inside
 * quickbars, task cards or action toolbars (those zones are covered by help
 * mode instead — the `help-icon-creep` anti-pattern).
 *
 * Hover opens the HelpCard after a short intent delay; click pins it
 * (Escape / outside click closes). Keyboard: focus + Enter pins too.
 */

const HOVER_INTENT_MS = 300;
const HOVER_CLOSE_GRACE_MS = 200;

interface HelpSpotProps {
	/** Topic id from the `help.ts` registry… */
	topicId?: string;
	/** …or ad-hoc content (custom column descriptions). One of the two is required. */
	content?: HelpCardContent;
	placement?: PopoverPlacement;
	className?: string;
}

export default function HelpSpot({ topicId, content, placement = "bottom", className }: HelpSpotProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [pinned, setPinned] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const topic = topicId ? helpTopic(topicId) : undefined;

	const clearTimers = useCallback(() => {
		if (openTimer.current !== null) clearTimeout(openTimer.current);
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		openTimer.current = null;
		closeTimer.current = null;
	}, []);

	useEffect(() => clearTimers, [clearTimers]);

	const close = useCallback(() => {
		clearTimers();
		setOpen(false);
		setPinned(false);
	}, [clearTimers]);

	const handleMouseEnter = () => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		if (open || openTimer.current !== null) return;
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			setOpen(true);
		}, HOVER_INTENT_MS);
	};

	const scheduleClose = () => {
		if (openTimer.current !== null) {
			clearTimeout(openTimer.current);
			openTimer.current = null;
		}
		if (!open || pinned) return;
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setOpen(false);
		}, HOVER_CLOSE_GRACE_MS);
	};

	const handleClick = () => {
		clearTimers();
		if (open && pinned) {
			close();
			return;
		}
		setOpen(true);
		setPinned(true);
	};

	if (!topic && !content) return null;

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				aria-label={t("help.ui.aboutSection")}
				aria-expanded={open}
				className={`inline-flex items-center justify-center w-4 h-4 rounded text-fg-muted hover:text-accent focus-visible:text-accent transition-colors text-[0.75rem] leading-none flex-shrink-0 ${className ?? ""}`}
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={scheduleClose}
				onClick={(e) => {
					e.stopPropagation();
					handleClick();
				}}
			>
				{"\uf05a"}
			</button>
			{open && buttonRef.current ? (
				<HelpCard
					topic={topic}
					content={content}
					anchorEl={buttonRef.current}
					placement={placement}
					pinned={pinned}
					onClose={close}
					onMouseEnter={handleMouseEnter}
					onMouseLeave={scheduleClose}
				/>
			) : null}
		</>
	);
}
