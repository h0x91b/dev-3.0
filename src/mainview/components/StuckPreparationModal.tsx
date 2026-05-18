import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { STUCK_PREPARATION_FETCH_THRESHOLD_MS, type Task } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";

const TROUBLESHOOTING_URL = "https://github.com/h0x91b/dev-3.0#macos--full-disk-access-required-for-git--tmux";
const TICK_INTERVAL_MS = 15_000;

function isDarwin(): boolean {
	const p = (navigator.platform || "").toLowerCase();
	return p.includes("mac") || p.includes("darwin");
}

function pickStuckTask(tasks: Task[], now: number, dismissed: ReadonlySet<string>): Task | null {
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
		if (elapsed < STUCK_PREPARATION_FETCH_THRESHOLD_MS) continue;
		if (startedAt < oldestStartedAt) {
			oldestStartedAt = startedAt;
			oldest = task;
		}
	}
	return oldest;
}

interface StuckPreparationModalProps {
	tasks: Task[];
}

function StuckPreparationModal({ tasks }: StuckPreparationModalProps) {
	const t = useT();
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	const [now, setNow] = useState<number>(() => Date.now());
	const mac = useMemo(() => isDarwin(), []);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
		return () => clearInterval(id);
	}, []);

	const stuck = useMemo(() => pickStuckTask(tasks, now, dismissed), [tasks, now, dismissed]);

	useEffect(() => {
		if (!stuck) return;
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				setDismissed((prev) => {
					if (prev.has(stuck!.id)) return prev;
					const next = new Set(prev);
					next.add(stuck!.id);
					return next;
				});
			}
		}
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, [stuck]);

	if (!stuck) return null;

	const thresholdMinutes = Math.round(STUCK_PREPARATION_FETCH_THRESHOLD_MS / 60_000);
	const taskTitle = stuck.title || stuck.id.slice(0, 8);

	function handleDismiss() {
		setDismissed((prev) => {
			const next = new Set(prev);
			next.add(stuck!.id);
			return next;
		});
	}

	function handleOpenGuide() {
		window.open(TROUBLESHOOTING_URL, "_blank");
	}

	async function handleOpenSettings() {
		try {
			await api.request.openSystemSettings({ pane: "fullDiskAccess" });
		} catch {
			// Best effort — Electrobun openExternal is fire-and-forget.
		}
	}

	return createPortal(
		<div
			data-stuck-preparation-modal="true"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
			onClick={handleDismiss}
		>
			{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
			<div
				className="relative bg-overlay border border-edge rounded-2xl shadow-2xl w-[36rem] max-w-[90vw] max-h-[80vh] flex flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-edge">
					<div className="flex items-center gap-2 min-w-0">
						<span
							className="text-[1.25rem] leading-none text-danger shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-hidden="true"
						>
							{"\u{F0027}"}
						</span>
						<h2 className="text-fg text-lg font-semibold truncate">
							{t("stuckPrep.title")}
						</h2>
					</div>
					<button
						type="button"
						onClick={handleDismiss}
						className="text-fg-muted hover:text-fg transition-colors p-1 -mr-1 rounded-lg hover:bg-fg/5 shrink-0"
						aria-label={t("stuckPrep.dismiss")}
					>
						<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				<div className="px-6 py-4 overflow-auto flex-1 space-y-3">
					<p className="text-sm text-fg-2 break-words" data-testid="stuck-prep-intro">
						{t("stuckPrep.intro", { taskTitle, minutes: String(thresholdMinutes) })}
					</p>
					<ul className="space-y-2">
						<li className="rounded-xl border border-edge bg-elevated/60 px-3 py-2">
							<div className="text-sm font-semibold text-fg">{t("stuckPrep.bulletNetworkTitle")}</div>
							<div className="text-xs text-fg-2 mt-0.5">{t("stuckPrep.bulletNetworkBody")}</div>
						</li>
						<li className="rounded-xl border border-edge bg-elevated/60 px-3 py-2">
							<div className="text-sm font-semibold text-fg">{t("stuckPrep.bulletFdaTitle")}</div>
							<div className="text-xs text-fg-2 mt-0.5">{t("stuckPrep.bulletFdaBody")}</div>
						</li>
					</ul>
				</div>

				<div className="flex flex-wrap items-center justify-end gap-2 px-6 pt-2 pb-6">
					<button
						type="button"
						onClick={handleDismiss}
						className="px-4 py-2 text-sm font-medium text-fg-2 hover:text-fg bg-elevated hover:bg-elevated-hover border border-edge rounded-xl transition-colors"
					>
						{t("stuckPrep.dismiss")}
					</button>
					{mac && (
						<button
							type="button"
							onClick={handleOpenSettings}
							data-testid="stuck-prep-open-settings"
							className="px-4 py-2 text-sm font-medium text-fg bg-elevated hover:bg-elevated-hover border border-edge-active rounded-xl transition-colors"
						>
							{t("stuckPrep.openSettings")}
						</button>
					)}
					<button
						type="button"
						onClick={handleOpenGuide}
						data-testid="stuck-prep-open-guide"
						className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-xl transition-colors"
					>
						{t("stuckPrep.openGuide")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

export default StuckPreparationModal;
export { pickStuckTask };
