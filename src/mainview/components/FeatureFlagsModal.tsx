import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import { api } from "../rpc";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { refreshFeatureFlagsNow } from "../feature-flags";
import { FEATURE_FLAG_REFRESH_MS } from "../../shared/feature-flags";

/** Re-read bun while the window is open, so a flag flip shows up without reopening. */
const POLL_MS = 1000;

interface FeatureFlagsModalProps {
	onClose: () => void;
}

/**
 * Debug → Feature Flags. Read-only: the values are the ones bun gates code on,
 * next to the PostHog distinct id a rollout can be targeted at.
 */
export default function FeatureFlagsModal({ onClose }: FeatureFlagsModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);

	const [flags, setFlags] = useState<Record<string, boolean> | null>(null);
	const [copied, setCopied] = useState(false);
	const [distinctId, setDistinctId] = useState("");

	const load = useCallback(() => {
		api.request.getFeatureFlags().then(setFlags).catch(() => {});
	}, []);

	useEffect(() => {
		api.request.resolveAnalyticsDistinctId({}).then((r) => setDistinctId(r.distinctId)).catch(() => {});
	}, []);

	useEffect(() => {
		load();
		const timer = window.setInterval(load, POLL_MS);
		return () => window.clearInterval(timer);
	}, [load]);

	function handleCopy() {
		navigator.clipboard.writeText(distinctId).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		}).catch(() => {});
	}

	const entries = Object.entries(flags ?? {});

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
				aria-labelledby="feature-flags-dialog-title"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] p-6 space-y-4 outline-none"
			>
				<h2 id="feature-flags-dialog-title" className="text-fg text-lg font-semibold">
					{t("featureFlags.title")}
				</h2>

				<div className="space-y-1">
					<p className="text-fg-3 text-xs">{t("featureFlags.effectiveHint")}</p>
					{flags === null
						? <p className="text-fg-muted text-sm py-2">{t("featureFlags.loading")}</p>
						: entries.length === 0
							? (
								<div className="py-2 space-y-1">
									<p className="text-fg-muted text-sm">{t("featureFlags.empty")}</p>
									<p className="text-fg-muted text-micro">{t("featureFlags.emptyHint")}</p>
								</div>
								)
							: (
								<ul className="divide-y divide-edge border border-edge rounded-lg overflow-hidden">
									{entries.map(([key, value]) => (
										<li key={key} className="flex items-center justify-between gap-3 px-3 py-2 bg-elevated">
											<code className="text-fg-2 text-xs font-mono truncate">{key}</code>
											<span
												className={`shrink-0 px-2 py-0.5 rounded text-micro font-medium ${
													value ? "bg-success/15 text-success" : "bg-raised text-fg-muted"
												}`}
											>
												{value ? t("featureFlags.on") : t("featureFlags.off")}
											</span>
										</li>
									))}
								</ul>
							)}
				</div>

				<div className="space-y-1">
					<p className="text-fg-3 text-xs">{t("featureFlags.distinctIdLabel")}</p>
					<div className="flex items-center gap-2">
						<code className="streamer-private flex-1 min-w-0 truncate px-3 py-2 rounded-lg bg-elevated border border-edge text-fg-2 text-xs font-mono">
							{distinctId || t("featureFlags.distinctIdMissing")}
						</code>
						<button
							type="button"
							onClick={handleCopy}
							disabled={!distinctId}
							title={t("featureFlags.copy")}
							aria-label={t("featureFlags.copy")}
							className={`shrink-0 px-3 py-2 text-xs rounded-lg border transition-colors disabled:opacity-40 ${
								copied
									? "border-success/40 bg-success/10 text-success"
									: "border-edge text-fg-2 hover:text-fg hover:bg-elevated"
							}`}
						>
							{copied ? t("featureFlags.copied") : t("featureFlags.copy")}
						</button>
					</div>
				</div>

				<p className="text-fg-muted text-xs">
					{t("featureFlags.cadence", { minutes: String(Math.round(FEATURE_FLAG_REFRESH_MS / 60000)) })}
				</p>

				<div className="flex justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={refreshFeatureFlagsNow}
						className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
					>
						{t("featureFlags.refreshNow")}
					</button>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors"
					>
						{t("featureFlags.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
