import { useEffect, useLayoutEffect, useRef, useState, type Dispatch } from "react";
import { createPortal } from "react-dom";
import type { Project, Task } from "../../shared/types";
import type { AppAction } from "../state";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import { formatCountdown } from "../../shared/duration";
import Tooltip from "./Tooltip";

interface ScheduledMessagesChipProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	/**
	 * Preferred popover direction. Board cards sit low, so the queue opens upward
	 * (default); the inspector session bar sits at the top, so it opens down. The
	 * popover flips to the opposite side when the preferred side would overflow.
	 */
	placement?: "up" | "down";
}

/**
 * Countdown chip + popover listing a task's pending scheduled messages
 * ("Send later"), each with Send now / Cancel. Shared by the board `TaskCard`
 * and the task inspector session bar so the queue is reachable from both the
 * board and an open task — the single place that renders/controls the queue.
 * Renders nothing when the queue is empty.
 *
 * The popover is rendered through a portal with `fixed` positioning (same pattern
 * as the sibling session-bar dropdowns, e.g. `statusDropdownPortal`). An
 * `absolute` popover nested in the session bar / card is painted *under* the
 * terminal pane and the card hover-preview, hiding every message past the first;
 * portaling to `document.body` escapes those stacking contexts.
 */
function ScheduledMessagesChip({ task, project, dispatch, placement = "up" }: ScheduledMessagesChipProps) {
	const t = useT();
	const messages = task.scheduledMessages ?? [];
	const sorted = [...messages].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
	const [open, setOpen] = useState(false);
	const [, setTick] = useState(0);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);

	// Re-render every 30s so the countdown stays fresh without a per-second tick.
	useEffect(() => {
		if (messages.length === 0) return;
		const id = setInterval(() => setTick((n) => n + 1), 30_000);
		return () => clearInterval(id);
	}, [messages.length]);

	// Position the portaled popover next to the trigger, flipping to the other
	// side when the preferred one overflows the viewport. Measure before showing
	// (visibility gate) so it never flashes at the wrong spot.
	useLayoutEffect(() => {
		if (!open) {
			setVisible(false);
			return;
		}
		if (!popoverRef.current || !triggerRef.current) return;
		const pop = popoverRef.current.getBoundingClientRect();
		const trig = triggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = placement === "up" ? trig.top - pop.height - 6 : trig.bottom + 6;
		if (placement === "up" && top < pad) top = trig.bottom + 6;
		if (placement === "down" && top + pop.height > vh - pad) top = trig.top - pop.height - 6;

		let left = trig.left;
		if (left + pop.width > vw - pad) left = vw - pop.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
	}, [open, placement, messages.length]);

	// Close on outside click — a portaled popover lives outside the trigger's
	// subtree, so check both the trigger and the popover before closing.
	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			const target = e.target as Node;
			if (triggerRef.current?.contains(target)) return;
			if (popoverRef.current?.contains(target)) return;
			setOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	if (messages.length === 0) return null;
	const soonest = new Date(sorted[0].at).getTime();

	async function cancelMessage(e: React.MouseEvent, messageId: string) {
		e.stopPropagation();
		try {
			const updated = await api.request.cancelScheduledMessage({ taskId: task.id, projectId: project.id, messageId });
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.scheduleCancelFailed", { error: String(err) }));
		}
	}

	async function sendNow(e: React.MouseEvent, messageId: string) {
		e.stopPropagation();
		setOpen(false);
		try {
			const updated = await api.request.sendScheduledMessageNow({ taskId: task.id, projectId: project.id, messageId });
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			toast.error(t("task.sendNowFailed", { error: String(err) }));
		}
	}

	return (
		<>
			<Tooltip content={t("task.scheduledMessageTooltip")}>
				<button
					ref={triggerRef}
					data-testid="task-card-scheduled-message-badge"
					onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
					className="flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-accent transition-colors hover:bg-fg/5"
				>
					<svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
						<path d="M22 2 11 13" />
						<path d="M22 2 15 22l-4-9-9-4Z" />
					</svg>
					{formatCountdown(soonest - Date.now())}
					{messages.length > 1 && <span className="text-fg-3">·{messages.length}</span>}
				</button>
			</Tooltip>
			{open && createPortal(
				<div
					ref={popoverRef}
					className="fixed z-50 min-w-[13rem] max-w-[18rem] rounded-lg border border-edge-active bg-overlay shadow-2xl shadow-black/40 py-1"
					style={{ top: pos.top, left: pos.left, visibility: visible ? "visible" : "hidden" }}
					onClick={(e) => e.stopPropagation()}
				>
					{sorted.map((m) => (
						<div key={m.id} className="px-3 py-1.5">
							<div className="text-xs text-fg-2 truncate" title={m.text}>{m.text}</div>
							<div className="mt-1 flex items-center justify-between gap-2">
								<span className="text-[0.625rem] text-fg-3">
									{formatCountdown(new Date(m.at).getTime() - Date.now())}
								</span>
								<div className="flex items-center gap-3">
									<button
										onClick={(e) => sendNow(e, m.id)}
										className="text-xs text-fg hover:text-accent transition-colors"
									>
										{t("task.sendNow")}
									</button>
									<button
										onClick={(e) => cancelMessage(e, m.id)}
										className="text-xs text-danger hover:opacity-80 transition-opacity"
									>
										{t("kanban.cancel")}
									</button>
								</div>
							</div>
						</div>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}

export default ScheduledMessagesChip;
