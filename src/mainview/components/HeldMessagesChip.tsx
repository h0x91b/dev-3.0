import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import { clearHeldAgentMessageCount, useHeldAgentMessageCount } from "../held-agent-messages";
import Tooltip from "./Tooltip";

interface HeldMessagesChipProps {
	taskId: string;
	/** Same as `ScheduledMessagesChip`: cards open upward, the inspector bar downward. */
	placement?: "up" | "down";
}

/**
 * "N waiting": messages dev3 keeps out of an agent pane that shows a permission menu or
 * question picker (#2342). Its popover holds the one escape hatch, Send now, for a prompt
 * dev3 believes is open while the user can see it is not (Esc fires no hook). Shared by
 * the board card and the inspector session bar, like `ScheduledMessagesChip`; renders
 * nothing while nothing waits.
 */
function HeldMessagesChip({ taskId, placement = "up" }: HeldMessagesChipProps) {
	const t = useT();
	const count = useHeldAgentMessageCount(taskId);
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);

	useLayoutEffect(() => {
		if (!open) {
			setVisible(false);
			return;
		}
		if (!popoverRef.current || !triggerRef.current) return;
		const pop = popoverRef.current.getBoundingClientRect();
		const trig = triggerRef.current.getBoundingClientRect();
		const pad = 8;
		let top = placement === "up" ? trig.top - pop.height - 6 : trig.bottom + 6;
		if (placement === "up" && top < pad) top = trig.bottom + 6;
		if (placement === "down" && top + pop.height > window.innerHeight - pad) top = trig.top - pop.height - 6;
		const left = Math.max(pad, Math.min(trig.left, window.innerWidth - pop.width - pad));
		setPos({ top: Math.max(pad, top), left });
		setVisible(true);
	}, [open, placement]);

	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			const target = e.target as Node;
			if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
			setOpen(false);
		}
		// Capture on window, ahead of App's Escape shortcut: closing the popover must not
		// also navigate back to the dashboard.
		function onKey(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey, { capture: true });
		return () => {
			document.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey, { capture: true });
		};
	}, [open]);

	useEffect(() => {
		if (count === 0) setOpen(false);
	}, [count]);

	if (count === 0) return null;

	async function sendNow(e: React.MouseEvent) {
		e.stopPropagation();
		setOpen(false);
		try {
			const { released } = await api.request.sendHeldAgentMessagesNow({ taskId });
			if (released === 0) clearHeldAgentMessageCount(taskId);
		} catch (err) {
			toast.error(t("task.heldMessagesSendFailed", { error: String(err) }), { taskId });
		}
	}

	const label = t.plural("task.heldMessages", count);
	return (
		<>
			<Tooltip content={t.plural("task.heldMessagesTooltip", count)}>
				<button
					ref={triggerRef}
					type="button"
					data-testid="task-held-messages-chip"
					aria-label={label}
					aria-expanded={open}
					onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
					className="flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-accent transition-colors hover:bg-fg/5"
				>
					<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<rect x="2" y="4" width="20" height="16" rx="2" />
						<path d="m22 7-10 6L2 7" />
					</svg>
					{label}
				</button>
			</Tooltip>
			{open && createPortal(
				<div
					ref={popoverRef}
					role="dialog"
					aria-label={label}
					className="fixed z-50 w-[16rem] rounded-lg border border-edge-active bg-overlay shadow-2xl shadow-black/40 px-3 py-2"
					style={{ top: pos.top, left: pos.left, visibility: visible ? "visible" : "hidden" }}
					onClick={(e) => e.stopPropagation()}
				>
					<p className="text-xs text-fg-2 text-pretty">{t("task.heldMessagesHint")}</p>
					<div className="mt-2 flex justify-end">
						<button
							type="button"
							data-testid="task-held-messages-send-now"
							onClick={sendNow}
							className="rounded-md px-2 py-1 text-xs text-fg transition-colors hover:bg-overlay-hover hover:text-accent active:scale-[0.96]"
						>
							{t("task.sendNow")}
						</button>
					</div>
				</div>,
				document.body,
			)}
		</>
	);
}

export default HeldMessagesChip;
