import { useCallback, useEffect, useRef, useState } from "react";
import { PXPIPE_PROXY_BASE_URL, type GlobalSettings, type PxpipeProxyStatus } from "../../../shared/types";
import type { TFunction } from "../../i18n";
import { api } from "../../rpc";
import { toast } from "../../toast";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";

interface PxpipeProxySettingsSectionProps {
	t: TFunction;
	globalSettings: GlobalSettings;
	onToggle: (enabled: boolean) => void;
}

type StatusDot = "success" | "warning" | "danger" | "muted";

const DOT_CLASS: Record<StatusDot, string> = {
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-danger",
	muted: "bg-fg-muted",
};

function StatusRow({ dot, children }: { dot: StatusDot; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2 text-sm text-fg-2">
			<span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_CLASS[dot]}`} aria-hidden />
			<span className="min-w-0">{children}</span>
		</div>
	);
}

export default function PxpipeProxySettingsSection({
	t,
	globalSettings,
	onToggle,
}: PxpipeProxySettingsSectionProps) {
	const enabled = globalSettings.pxpipeProxyEnabled === true;
	const [status, setStatus] = useState<PxpipeProxyStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

	const refresh = useCallback(async () => {
		try {
			setStatus(await api.request.pxpipeProxyStatus());
		} catch {
			/* transient — keep the last known status */
		}
	}, []);

	// While the section is open AND the feature is enabled, poll so a
	// starting → running transition (npx download finishing) reflects live.
	useEffect(() => {
		if (!enabled) {
			setStatus(null);
			return;
		}
		void refresh();
		pollRef.current = setInterval(() => void refresh(), 3000);
		return () => clearInterval(pollRef.current);
	}, [enabled, refresh]);

	const handleStart = useCallback(async () => {
		setBusy(true);
		try {
			setStatus(await api.request.pxpipeProxyStart());
		} catch (err) {
			toast.error(t("pxpipe.startError", { error: String(err) }));
		} finally {
			setBusy(false);
		}
	}, [t]);

	const handleStop = useCallback(async () => {
		setBusy(true);
		try {
			setStatus(await api.request.pxpipeProxyStop());
		} catch (err) {
			toast.error(t("pxpipe.stopError", { error: String(err) }));
		} finally {
			setBusy(false);
		}
	}, [t]);

	// The dashboard lives on the fixed proxy port — only reachable once the proxy
	// is actually running, so the link is surfaced inside the status block below
	// (and only while running), not in the always-visible links row.
	const dashboardUrl = status?.dashboardUrl ?? `${PXPIPE_PROXY_BASE_URL}/`;

	return (
		<SettingsEntry anchor="token-saving-proxy">
			<SettingsSection
				title={t("settings.pxpipeSection")}
				description={t("settings.pxpipeSectionDesc")}
				helpTopicId="settings.pxpipe"
			>
				{/* Honesty callout — always visible, even when off. */}
				<div className="rounded-xl border border-warning/30 bg-warning/10 p-3">
					<p className="text-warning text-sm font-semibold mb-1">
						{t("pxpipe.warningTitle")}
					</p>
					<p className="text-fg-2 text-xs leading-relaxed">{t("pxpipe.warningBody")}</p>
				</div>

				{/* Always-available link: the upstream pxpipe repo (credit). The
				    dashboard link lives inside the status block — it only works once
				    the proxy is running. */}
				<div className="flex flex-wrap items-center gap-4 text-sm">
					<a
						href="https://github.com/teamchong/pxpipe"
						target="_blank"
						rel="noopener noreferrer"
						className="text-accent hover:text-accent-hover"
					>
						{t("pxpipe.viewRepo")}
					</a>
				</div>

				{/* Master toggle */}
				<label className="inline-flex items-center gap-3 cursor-pointer select-none">
					<div
						role="switch"
						aria-checked={enabled}
						aria-label={t("settings.pxpipeSection")}
						tabIndex={0}
						className={`relative w-11 h-6 rounded-full transition-colors ${
							enabled ? "bg-accent" : "bg-raised border border-edge"
						}`}
						onClick={() => onToggle(!enabled)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onToggle(!enabled);
							}
						}}
					>
						<div
							className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
								enabled ? "translate-x-5" : ""
							}`}
						/>
					</div>
					<span className="text-fg text-sm">{t("pxpipe.enableLabel")}</span>
				</label>

				{/* Live status — only while enabled. */}
				{enabled && (
					<div className="space-y-3 rounded-xl border border-edge bg-raised p-4">
						{/* npx availability */}
						{status?.npxAvailable ? (
							<StatusRow dot="success">{t("pxpipe.npxAvailable")}</StatusRow>
						) : (
							<div className="space-y-1">
								<StatusRow dot="danger">{t("pxpipe.npxMissing")}</StatusRow>
								<p className="text-fg-3 text-xs pl-4">{t("pxpipe.npxMissingHint")}</p>
							</div>
						)}

						{/* Port / proxy state */}
						{status?.running ? (
							<StatusRow dot="success">
								{t("pxpipe.statusRunning", { pid: String(status.holderPid ?? "?") })}
							</StatusRow>
						) : status?.starting ? (
							<StatusRow dot="warning">{t("pxpipe.statusStarting")}</StatusRow>
						) : status?.foreignConflict ? (
							<StatusRow dot="danger">
								{t("pxpipe.statusForeign", {
									port: String(status.port),
									name: status.holderName ?? "?",
									pid: String(status.holderPid ?? "?"),
								})}
							</StatusRow>
						) : (
							<StatusRow dot="muted">
								{t("pxpipe.statusStopped", { port: String(status?.port ?? "47821") })}
							</StatusRow>
						)}

						{/* Actions */}
						<div className="flex flex-wrap items-center gap-2 pt-1">
							{status?.running || status?.starting ? (
								<button
									type="button"
									onClick={handleStop}
									disabled={busy}
									className="text-sm px-3 py-1.5 rounded-lg border border-edge bg-raised text-fg hover:border-edge-active transition-colors disabled:opacity-50"
								>
									{t("pxpipe.stop")}
								</button>
							) : (
								<button
									type="button"
									onClick={handleStart}
									disabled={busy || !status?.npxAvailable || status?.foreignConflict}
									className="text-sm px-3 py-1.5 rounded-lg border border-edge bg-raised text-fg hover:border-edge-active transition-colors disabled:opacity-50"
								>
									{t("pxpipe.start")}
								</button>
							)}
						</div>

						{/* Dashboard (savings breakdown) — only reachable while the proxy
						    is actually running, so surface it only then. */}
						{status?.running && (
							<a
								href={dashboardUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-block text-sm text-accent hover:text-accent-hover"
							>
								{t("pxpipe.openDashboard")}
							</a>
						)}
					</div>
				)}

				{/* Credit — the token-saving trick and proxy are the work of the
				    pxpipe authors (repo link lives in the links row above). */}
				<p className="text-fg-3 text-xs">{t("pxpipe.credit")}</p>
			</SettingsSection>
		</SettingsEntry>
	);
}
