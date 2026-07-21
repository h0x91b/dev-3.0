import { useCallback, useEffect, useState } from "react";
import type { UpdatePopoverPreview } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import UpdateReadyPopover from "./UpdateReadyPopover";

/**
 * Dev-only simulator: shows exactly what the update-ready popover's "what's new"
 * section will render on the NEXT release, computed from the local change-logs +
 * git tags (including uncommitted files). Renders the real popover 1:1 plus the
 * raw payload and window diagnostics so a developer can see what makes it in.
 */
export default function UpdatePopoverSimulatorModal({ onClose }: { onClose: () => void }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);

	const [loading, setLoading] = useState(true);
	const [version, setVersion] = useState("");
	const [preview, setPreview] = useState<UpdatePopoverPreview | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [v, p] = await Promise.all([api.request.getAppVersion(), api.request.previewUpdatePopover()]);
			setVersion(v.version);
			setPreview(p);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const diag = preview?.diagnostics;

	// Window can hold refactor/docs/chore entries that never surface in the
	// popover (features + fixes only), so the window count is >= what the popover
	// shows. Break it down by type so the difference is never a mystery.
	const typeCounts = (diag?.windowFiles ?? []).reduce<Record<string, number>>((acc, f) => {
		const type = f.split("-")[0] || "other";
		acc[type] = (acc[type] ?? 0) + 1;
		return acc;
	}, {});
	const typeBreakdown = Object.entries(typeCounts)
		.sort((a, b) => b[1] - a[1])
		.map(([type, n]) => `${n} ${type}`)
		.join(" · ");

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[36rem] max-h-[85vh] flex flex-col outline-none"
			>
				<div className="flex items-start justify-between gap-3 p-5 border-b border-edge">
					<div className="min-w-0">
						<h2 className="text-fg text-base font-semibold">{t("updateSim.title")}</h2>
						<p className="text-fg-3 text-xs mt-0.5">{t("updateSim.subtitle")}</p>
					</div>
					<button
						type="button"
						onClick={() => void load()}
						disabled={loading}
						className="flex-shrink-0 px-3 py-1.5 text-xs rounded-lg bg-raised hover:bg-raised-hover text-fg border border-edge transition-colors disabled:opacity-50"
					>
						{t("updateSim.refresh")}
					</button>
				</div>

				<div className="p-5 space-y-4 overflow-y-auto">
					{loading ? (
						<p className="text-fg-3 text-sm">{t("updateSim.loading")}</p>
					) : error || !preview?.available ? (
						<div className="text-fg-2 text-sm space-y-1">
							<p>{t("updateSim.unavailable")}</p>
							<p className="text-fg-muted text-xs font-mono">{error ?? preview?.reason}</p>
						</div>
					) : (
						<>
							<div className="flex flex-col items-center gap-2">
								<div className="rounded-xl bg-base/60 p-4">
									<UpdateReadyPopover
										preview
										version={version}
										changelog={preview.changelog}
										restarting={false}
										onRestart={() => {}}
										onSeeAllChanges={() => {}}
									/>
								</div>
								<p className="text-fg-muted text-[0.6875rem]">{t("updateSim.previewNote")}</p>
							</div>

							<div className="border-t border-edge pt-3 space-y-2">
								<div className="text-fg-3 text-[0.625rem] font-semibold uppercase tracking-wider">
									{t("updateSim.diagnostics")}
								</div>
								<div className="flex flex-wrap items-center gap-2 text-xs">
									<span className="text-fg-2">
										{t("updateSim.prevTag")}:{" "}
										<span className="font-mono text-fg">{diag?.prevTag ?? t("updateSim.noTag")}</span>
									</span>
									{diag?.usedFallback && (
										<span className="px-1.5 py-0.5 rounded bg-raised text-fg-muted text-[0.625rem] font-medium">
											{t("updateSim.fallbackBadge")}
										</span>
									)}
									<span className="text-fg-muted">{t("updateSim.totalEntries", { count: String(diag?.totalEntries ?? 0) })}</span>
									{diag && diag.mergedPRs > 0 && (
										<span className="text-fg-muted">{t("updateSim.mergedPRs", { count: String(diag.mergedPRs) })}</span>
									)}
								</div>
								<p className="text-fg-muted text-[0.6875rem]">{t("updateSim.includesUncommitted")}</p>
								{typeBreakdown && (
									<p className="text-fg-2 text-[0.6875rem]">
										{typeBreakdown} <span className="text-fg-muted">— {t("updateSim.popoverShowsNote")}</span>
									</p>
								)}

								<div className="text-fg-3 text-xs font-medium pt-1">
									{t("updateSim.windowFiles", { count: String(diag?.windowFiles.length ?? 0) })}
								</div>
								{diag && diag.windowFiles.length > 0 ? (
									<ul className="space-y-0.5 max-h-40 overflow-y-auto">
										{diag.windowFiles.map((f) => (
											<li key={f} className="text-fg-2 text-xs font-mono truncate">
												{f}
											</li>
										))}
									</ul>
								) : (
									<p className="text-fg-muted text-xs">{t("updateSim.emptyWindow")}</p>
								)}

								<div className="text-fg-3 text-xs font-medium pt-1">{t("updateSim.rawPayload")}</div>
								<pre className="text-fg-2 text-[0.6875rem] font-mono bg-base rounded-lg p-3 overflow-x-auto">
									{JSON.stringify(preview.changelog, null, 2)}
								</pre>
							</div>
						</>
					)}
				</div>

				<div className="flex justify-end p-4 border-t border-edge">
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
					>
						{t("updateSim.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
