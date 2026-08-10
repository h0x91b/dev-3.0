import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import { api } from "../rpc";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { evaluatingDistinctId, refreshFeatureFlagsNow } from "../feature-flags";
import { FEATURE_FLAG_REFRESH_MS } from "../../shared/feature-flags";

/** Re-read bun while the window is open, so a flag flip shows up without reopening. */
const POLL_MS = 1000;
/** How long the refresh verdict stays on screen before the button goes quiet again. */
const VERDICT_MS = 4000;

type RefreshState = "idle" | "pending" | "answered" | "silent";

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
	const [refreshState, setRefreshState] = useState<RefreshState>("idle");
	// What PostHog evaluates this renderer as — the id a rollout has to target.
	// Empty when the build carries no PostHog key: then nothing evaluates at all.
	const [evaluatingId] = useState(evaluatingDistinctId);
	// What the host stored. Equal to the above unless the handover broke, and then
	// seeing both is the whole diagnosis.
	const [storedId, setStoredId] = useState("");

	const load = useCallback(() => {
		api.request.getFeatureFlags().then(setFlags).catch(() => {});
	}, []);

	useEffect(() => {
		api.request.resolveAnalyticsDistinctId({}).then((r) => setStoredId(r.distinctId)).catch(() => {});
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

	function handleRefresh() {
		if (refreshState === "pending") return;
		setRefreshState("pending");
		refreshFeatureFlagsNow().then((answered) => {
			load();
			setRefreshState(answered ? "answered" : "silent");
			window.setTimeout(() => setRefreshState("idle"), VERDICT_MS);
		});
	}

	const entries = Object.entries(flags ?? {});
	// No client means no evaluation, so fall back to the host's copy rather than an
	// empty row — the id is still what a rollout will have to target later.
	const noClient = !evaluatingId;
	const distinctId = evaluatingId || storedId;
	const idMismatch = !!evaluatingId && !!storedId && evaluatingId !== storedId;
	const refreshLabel = refreshState === "pending" ? t("featureFlags.refreshing") : t("featureFlags.refreshNow");

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
					{noClient && <p className="text-warning text-micro">{t("featureFlags.noClient")}</p>}
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
					{idMismatch && (
						<p className="text-warning text-micro">
							{t("featureFlags.idMismatch", { stored: storedId })}
						</p>
					)}
				</div>

				<p className="text-fg-muted text-xs">
					{t("featureFlags.cadence", { minutes: String(Math.round(FEATURE_FLAG_REFRESH_MS / 60000)) })}
				</p>

				<div className="flex items-center justify-end gap-3 pt-1">
					<span
						aria-live="polite"
						className={`mr-auto text-micro transition-opacity ${
							refreshState === "answered"
								? "text-success opacity-100"
								: refreshState === "silent"
									? "text-danger opacity-100"
									: "opacity-0"
						}`}
					>
						{refreshState === "silent" ? t("featureFlags.refreshFailed") : t("featureFlags.refreshed")}
					</span>
					<button
						type="button"
						onClick={handleRefresh}
						disabled={refreshState === "pending"}
						className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors active:scale-[0.96] disabled:opacity-50 disabled:active:scale-100"
					>
						{refreshLabel}
					</button>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors active:scale-[0.96]"
					>
						{t("featureFlags.close")}
					</button>
				</div>
			</div>
		</div>
	);
}
