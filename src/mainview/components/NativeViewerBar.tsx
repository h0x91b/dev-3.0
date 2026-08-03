import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";
import type { NativeStreamRole, NativeViewerStatus } from "../../shared/native-terminal-stream";

/**
 * Earned read-only strip for a NATIVE task terminal (seq 1300).
 *
 * A native session has one PTY and no client arbitration of its own, so exactly
 * one viewer — desktop window or remote browser tab — may type; the rest watch
 * until they explicitly take over. This strip exists because a silently
 * read-only terminal is indistinguishable from a hung one.
 *
 * Placement follows the terminal's existing slim-strip pattern (window switcher,
 * pane dots): a NON-overlapping row directly above the canvas, identical on
 * desktop and narrow viewports, rendered only for an observer. A writer — and
 * every tmux terminal — sees no chrome at all.
 */
const REFUSED_FLASH_MS = 1600;

/**
 * What each honest refusal says. There is no "lost a race" entry: the host serializes
 * takeovers and the last explicit one wins, so the gesture cannot lose to a rival.
 */
const REFUSAL_COPY = {
	"host-too-old": { label: "nativeViewer.hostTooOld", hint: "nativeViewer.hostTooOldHint" },
	"transfer-failed": { label: "nativeViewer.transferFailed", hint: "nativeViewer.transferFailedHint" },
} as const;

interface NativeViewerBarProps {
	role: NativeStreamRole;
	/** Bumped each time the server refused this viewer's input, to flash the strip. */
	refusedAt: number;
	/**
	 * Why the last `Take control` did not transfer the lease. `host-too-old` cannot
	 * be fixed by clicking again, so it gets its own sentence instead of the
	 * retryable one — a strip that says the same thing either way is a dead end.
	 */
	refusedReason?: NativeViewerStatus["refusedReason"];
	/**
	 * Whether anyone holds the write lease. False means the slot is free — saying
	 * "another viewer is typing" then is simply untrue, and the fix is one click.
	 */
	writerAttached?: boolean;
	onTakeControl: () => void;
}

function NativeViewerBar({ role, refusedAt, refusedReason, writerAttached, onTakeControl }: NativeViewerBarProps) {
	const t = useT();
	const [flashing, setFlashing] = useState(false);
	/** Whether the persistent old-host guidance is the thing currently on screen. */
	const showingGuidance = useRef(false);
	// One place decides what a refusal SAYS, so the label and its hint can never drift.
	const refusal = (flashing || refusedReason === "host-too-old") && refusedReason ? REFUSAL_COPY[refusedReason] : null;

	useEffect(() => {
		if (!refusedAt) return;
		setFlashing(true);
		// `host-too-old` is GUIDANCE, not an event: clicking again cannot fix it, so the
		// sentence has to stay put until the host or connection state actually changes
		// (a new role frame clears `refusedReason`). Everything else is a brief flash.
		if (refusedReason === "host-too-old") return;
		const timer = setTimeout(() => setFlashing(false), REFUSED_FLASH_MS);
		return () => clearTimeout(timer);
	}, [refusedAt, refusedReason]);

	// Retire the guidance only when LEAVING it. A plain `!== host-too-old` check would
	// also fire on the first render of every other refusal and cancel its flash.
	useEffect(() => {
		if (refusedReason === "host-too-old") {
			showingGuidance.current = true;
			return;
		}
		if (!showingGuidance.current) return;
		showingGuidance.current = false;
		setFlashing(false);
	}, [refusedReason, writerAttached]);

	// The normal case is a writer, and the normal case gets zero chrome.
	if (role !== "observer") return null;

	return (
		<div
			role="status"
			className={`flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1 text-xs transition-colors ${
				flashing ? "border-danger/40 bg-danger/15 text-danger" : "border-edge bg-raised text-fg-3"
			}`}
		>
			<span className="truncate">
				{t(refusal ? refusal.label : flashing || writerAttached === false ? "nativeViewer.refused" : "nativeViewer.readOnly")}
			</span>
			{/* The strip TRUNCATES, so the why-and-what-to-do sentence lives on the button's
			    tooltip: it is the control you would reach for, and it is focusable. */}
			<Tooltip content={t(refusal ? refusal.hint : "nativeViewer.takeControlHint")} placement="bottom">
				<button
					type="button"
					onClick={onTakeControl}
					className="shrink-0 rounded border border-edge bg-elevated px-2 py-0.5 font-medium text-fg-2 transition-colors hover:border-edge-active hover:bg-elevated-hover hover:text-fg"
				>
					{t("nativeViewer.takeControl")}
				</button>
			</Tooltip>
		</div>
	);
}

export default NativeViewerBar;
