import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { STUCK_PREPARATION_FETCH_THRESHOLD_MS, type Task } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";

const TICK_INTERVAL_MS = 5_000;
const ANCHOR_POLL_MS = 250;
const POPOVER_WIDTH = 352;
const POPOVER_MAX_HEIGHT = 280;
const POPOVER_GAP = 12;
const POPOVER_MARGIN = 8;

function isDarwin(): boolean {
	const p = (navigator.platform || "").toLowerCase();
	return p.includes("mac") || p.includes("darwin");
}

function pickStuckTask(
	tasks: Task[],
	now: number,
	dismissed: ReadonlySet<string>,
	thresholdMs: number = STUCK_PREPARATION_FETCH_THRESHOLD_MS,
): Task | null {
	let oldest: Task | null = null;
	let oldestStartedAt = Infinity;
	for (const task of tasks) {
		if (task.preparing !== true) continue;
		if (task.preparingStage !== "fetching-origin") continue;
		if (!task.preparingStartedAt) continue;
		if (dismissed.has(task.id)) continue;
		const startedAt = Date.parse(task.preparingStartedAt);
		if (!Number.isFinite(startedAt)) continue;
		const elapsed = now - startedAt;
		if (elapsed < thresholdMs) continue;
		if (startedAt < oldestStartedAt) {
			oldestStartedAt = startedAt;
			oldest = task;
		}
	}
	return oldest;
}

interface PopoverPosition {
	top: number;
	left: number;
}

function computePosition(rect: DOMRect): PopoverPosition {
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	let left = rect.right + POPOVER_GAP;
	let top = rect.top;

	const fitsRight = left + POPOVER_WIDTH + POPOVER_MARGIN <= viewportWidth;
	if (!fitsRight) {
		const leftCandidate = rect.left - POPOVER_GAP - POPOVER_WIDTH;
		if (leftCandidate >= POPOVER_MARGIN) {
			left = leftCandidate;
		} else {
			// Fall back to below the card, horizontally clamped.
			top = rect.bottom + POPOVER_GAP;
			left = Math.min(
				Math.max(POPOVER_MARGIN, rect.left),
				viewportWidth - POPOVER_WIDTH - POPOVER_MARGIN,
			);
		}
	}

	// Vertical clamp.
	const maxTop = viewportHeight - POPOVER_MAX_HEIGHT - POPOVER_MARGIN;
	if (top > maxTop) top = Math.max(POPOVER_MARGIN, maxTop);
	if (top < POPOVER_MARGIN) top = POPOVER_MARGIN;

	return { top, left };
}

interface StuckPreparationPopoverProps {
	tasks: Task[];
	/** Test seam — when provided, skips the RPC fetch. */
	thresholdMsOverride?: number;
	/** Test seam — bypasses the navigator.platform check. */
	forcePlatformMac?: boolean;
}

function StuckPreparationPopover({ tasks, thresholdMsOverride, forcePlatformMac }: StuckPreparationPopoverProps) {
	const t = useT();
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	const [now, setNow] = useState<number>(() => Date.now());
	const [thresholdMs, setThresholdMs] = useState<number>(
		thresholdMsOverride ?? STUCK_PREPARATION_FETCH_THRESHOLD_MS,
	);
	const [position, setPosition] = useState<PopoverPosition | null>(null);
	const [cancelling, setCancelling] = useState(false);
	const mac = useMemo(() => forcePlatformMac ?? isDarwin(), [forcePlatformMac]);
	const lastFetchedThreshold = useRef(false);

	useEffect(() => {
		if (!mac) return;
		if (thresholdMsOverride !== undefined) return;
		if (lastFetchedThreshold.current) return;
		lastFetchedThreshold.current = true;
		let cancelled = false;
		let pending: Promise<{ ms: number }> | null = null;
		try {
			pending = api.request.getStuckPreparationThresholdMs();
		} catch {
			// Older builds without the RPC, or tests that omit the mock.
		}
		pending
			?.then((res) => {
				if (cancelled) return;
				if (typeof res?.ms === "number" && res.ms > 0) {
					setThresholdMs(res.ms);
				}
			})
			.catch(() => {
				// Keep the default constant — best-effort fetch.
			});
		return () => {
			cancelled = true;
		};
	}, [mac, thresholdMsOverride]);

	useEffect(() => {
		if (!mac) return;
		const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
		return () => clearInterval(id);
	}, [mac]);

	const stuck = useMemo(() => {
		if (!mac) return null;
		return pickStuckTask(tasks, now, dismissed, thresholdMs);
	}, [mac, tasks, now, dismissed, thresholdMs]);

	const updatePosition = useCallback(() => {
		if (!stuck) {
			setPosition(null);
			return;
		}
		const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(stuck.id)}"]`);
		if (!el) {
			setPosition(null);
			return;
		}
		setPosition(computePosition(el.getBoundingClientRect()));
	}, [stuck]);

	useEffect(() => {
		if (!stuck) {
			setPosition(null);
			return;
		}
		updatePosition();
		const id = setInterval(updatePosition, ANCHOR_POLL_MS);
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			clearInterval(id);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [stuck, updatePosition]);

	if (!mac || !stuck || !position) return null;

	async function handleOpenSettings() {
		try {
			await api.request.openSystemSettings({ pane: "fullDiskAccess" });
		} catch {
			// Best effort — Electrobun openExternal is fire-and-forget.
		}
		setDismissed((prev) => {
			const next = new Set(prev);
			next.add(stuck!.id);
			return next;
		});
	}

	async function handleCancel() {
		if (cancelling) return;
		setCancelling(true);
		try {
			await api.request.cancelTaskPreparation({
				taskId: stuck!.id,
				projectId: stuck!.projectId,
			});
		} catch {
			// Surface nothing — the popover dismisses regardless so the user
			// is not blocked; the underlying task state stream will reflect
			// whatever happened on the backend.
		}
		setDismissed((prev) => {
			const next = new Set(prev);
			next.add(stuck!.id);
			return next;
		});
		setCancelling(false);
	}

	const taskTitle = stuck.title || stuck.id.slice(0, 8);

	return createPortal(
		<div
			data-stuck-preparation-popover="true"
			data-task-id={stuck.id}
			role="dialog"
			aria-labelledby="stuck-prep-popover-title"
			className="fixed z-50 rounded-2xl border border-edge-active bg-overlay shadow-2xl shadow-black/40 backdrop-blur-md"
			style={{
				top: position.top,
				left: position.left,
				width: POPOVER_WIDTH,
				maxHeight: POPOVER_MAX_HEIGHT,
			}}
		>
			<div className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-edge">
				<span
					className="text-[1.125rem] leading-none text-danger shrink-0 mt-0.5"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					aria-hidden="true"
				>
					{"\u{F0027}"}
				</span>
				<div className="min-w-0 flex-1">
					<div id="stuck-prep-popover-title" className="text-sm font-semibold text-fg truncate">
						{t("stuckPrep.popoverTitle")}
					</div>
					<div className="text-xs text-fg-3 truncate mt-0.5" title={taskTitle}>
						{taskTitle}
					</div>
				</div>
			</div>

			<div className="px-4 py-3">
				<p className="text-xs text-fg-2 leading-relaxed" data-testid="stuck-prep-popover-body">
					{t("stuckPrep.popoverBody")}
				</p>
			</div>

			<div className="flex items-center justify-end gap-2 px-4 pb-4">
				<button
					type="button"
					onClick={handleCancel}
					disabled={cancelling}
					data-testid="stuck-prep-popover-cancel"
					className="px-3 py-1.5 text-xs font-medium text-danger border border-danger/50 bg-danger/10 hover:border-danger hover:bg-danger/15 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg transition-colors"
				>
					{t("stuckPrep.popoverCancel")}
				</button>
				<button
					type="button"
					onClick={handleOpenSettings}
					data-testid="stuck-prep-popover-open-settings"
					className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors"
				>
					{t("stuckPrep.popoverOpenSettings")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

export default StuckPreparationPopover;
export { pickStuckTask, computePosition };
