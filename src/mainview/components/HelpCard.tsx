import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dispatchHelpLinkAction, type HelpLinkAction, type HelpTopic } from "../help";
import { APP_SHORTCUTS, shortcutKeysForMode } from "../keymap";
import { isMac, isRemote } from "../utils/platform";
import { computeAnchoredPosition, type PopoverPlacement } from "../utils/popoverPosition";
import { useT } from "../i18n";
import { useEscapeKey } from "../hooks/useEscapeKey";

/**
 * The rich inline-help card (bible §5.4): renders a `HelpTopic` from the
 * `help.ts` registry — title, body, optional shortcut chips and a navigation
 * link. Read-only by contract: the only interactions are closing and the
 * optional nav link. Shown by `HelpSpot` (hover/pin) and by `HelpOverlay`
 * (help mode); both position it against an anchor rect via the shared
 * popover util.
 */

export interface HelpCardContent {
	title: string;
	body: string;
}

interface HelpCardProps {
	/** Registry topic — or `content` for ad-hoc text (custom column descriptions). */
	topic?: HelpTopic;
	content?: HelpCardContent;
	anchorEl: HTMLElement;
	placement?: PopoverPlacement;
	/** Pinned cards close on Escape / outside click; hover cards are closed by the opener. */
	pinned: boolean;
	onClose: () => void;
	onLinkAction?: (action: HelpLinkAction) => void;
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
}

export default function HelpCard({
	topic,
	content,
	anchorEl,
	placement = "bottom",
	pinned,
	onClose,
	onLinkAction,
	onMouseEnter,
	onMouseLeave,
}: HelpCardProps) {
	const t = useT();
	const cardRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

	useLayoutEffect(() => {
		if (!cardRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const rect = cardRef.current.getBoundingClientRect();
		const { top, left } = computeAnchoredPosition(
			anchor,
			{ width: rect.width, height: rect.height },
			{ placement, gap: 8 },
		);
		setPos({ top, left });
	}, [anchorEl, placement]);

	useEscapeKey(onClose, { enabled: pinned });

	useEffect(() => {
		if (!pinned) return;
		function handleMouseDown(e: MouseEvent) {
			if (
				cardRef.current &&
				!cardRef.current.contains(e.target as Node) &&
				!anchorEl.contains(e.target as Node)
			) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [pinned, anchorEl, onClose]);

	const title = topic ? t(topic.titleKey) : content?.title ?? "";
	const body = topic ? t(topic.bodyKey) : content?.body ?? "";
	const mac = isMac();
	const remote = isRemote();
	const shortcuts = (topic?.shortcutIds ?? [])
		.map((id) => APP_SHORTCUTS.find((s) => s.id === id))
		.filter((s): s is NonNullable<typeof s> => Boolean(s));

	return createPortal(
		<div
			ref={cardRef}
			role={pinned ? "dialog" : "tooltip"}
			aria-label={title}
			className="fixed z-[1250] w-[20rem] max-w-[calc(100vw-2rem)] bg-overlay border border-edge-active rounded-xl shadow-2xl shadow-black/40 p-3.5"
			style={{
				top: pos?.top ?? 0,
				left: pos?.left ?? 0,
				visibility: pos ? "visible" : "hidden",
			}}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="flex items-start gap-2">
				<span
					aria-hidden="true"
					className="text-accent text-[0.875rem] leading-5 flex-shrink-0"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\uf05a"}
				</span>
				<h3 className="text-fg text-sm font-semibold leading-5 min-w-0">{title}</h3>
			</div>
			<p className="text-fg-2 text-xs leading-relaxed mt-1.5 whitespace-pre-line">{body}</p>
			{shortcuts.length > 0 ? (
				<div className="flex flex-wrap gap-1.5 mt-2.5">
					{shortcuts.map((s) => (
						<span
							key={s.id}
							className="inline-flex items-center gap-1.5 text-[0.625rem] text-fg-3 bg-raised border border-edge rounded px-1.5 py-0.5"
						>
							<kbd className="font-mono text-fg-2">{shortcutKeysForMode(s, mac, remote)}</kbd>
							{t(s.descKey)}
						</span>
					))}
				</div>
			) : null}
			{topic?.link ? (
				<button
					type="button"
					className="mt-2.5 text-xs text-accent hover:text-accent-hover transition-colors"
					onClick={() => {
						const action = topic.link!.action;
						onClose();
						(onLinkAction ?? dispatchHelpLinkAction)(action);
					}}
				>
					{t(topic.link.labelKey)}
				</button>
			) : null}
		</div>,
		document.body,
	);
}
