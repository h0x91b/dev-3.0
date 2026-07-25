import { useEffect, useState } from "react";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";
import type { NativeStreamRole } from "../../shared/native-terminal-stream";

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

interface NativeViewerBarProps {
	role: NativeStreamRole;
	/** Bumped each time the server refused this viewer's input, to flash the strip. */
	refusedAt: number;
	onTakeControl: () => void;
}

function NativeViewerBar({ role, refusedAt, onTakeControl }: NativeViewerBarProps) {
	const t = useT();
	const [flashing, setFlashing] = useState(false);

	useEffect(() => {
		if (!refusedAt) return;
		setFlashing(true);
		const timer = setTimeout(() => setFlashing(false), REFUSED_FLASH_MS);
		return () => clearTimeout(timer);
	}, [refusedAt]);

	// The normal case is a writer, and the normal case gets zero chrome.
	if (role !== "observer") return null;

	return (
		<div
			role="status"
			className={`flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1 text-xs transition-colors ${
				flashing ? "border-danger/40 bg-danger/15 text-danger" : "border-edge bg-raised text-fg-3"
			}`}
		>
			<span className="truncate">{t(flashing ? "nativeViewer.refused" : "nativeViewer.readOnly")}</span>
			<Tooltip content={t("nativeViewer.takeControlHint")} placement="bottom">
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
