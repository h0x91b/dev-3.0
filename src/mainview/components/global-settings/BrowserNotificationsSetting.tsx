import { useEffect, useState } from "react";
import type { TFunction } from "../../i18n";
import { isElectrobun } from "../../rpc";
import {
	browserNotificationsEnabled,
	setBrowserNotificationsEnabled,
	webNotificationsSupported,
} from "../../utils/webNotification";
import { isSubscribed, pushReadiness, subscribeToPush, unsubscribeFromPush } from "../../utils/webPush";
import SettingsEntry from "./SettingsEntry";

type Permission = "default" | "granted" | "denied" | "unsupported";

function readPermission(): Permission {
	if (!webNotificationsSupported()) return "unsupported";
	return Notification.permission as Permission;
}

/** Browser-only delivery controls; the desktop app uses native notifications. */
export default function BrowserNotificationsSetting({ t }: { t: TFunction }) {
	const [permission, setPermission] = useState<Permission>(() => readPermission());
	const [muted, setMuted] = useState<boolean>(() => !browserNotificationsEnabled());
	const [isPushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
	const [permissionBusy, setPermissionBusy] = useState(false);
	const [pushBusy, setPushBusy] = useState(false);
	const [pushError, setPushError] = useState(false);
	const readiness = pushReadiness();

	useEffect(() => {
		void isSubscribed().then(setPushSubscribed).catch(() => setPushSubscribed(false));
	}, []);

	// Re-read on focus — the user may flip the browser's site permission elsewhere.
	useEffect(() => {
		const onFocus = () => {
			setPermission(readPermission());
			void isSubscribed().then(setPushSubscribed).catch(() => setPushSubscribed(false));
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	// Desktop app uses native notifications — nothing to configure here.
	if (isElectrobun) return null;

	async function requestPermission() {
		setPermissionBusy(true);
		try {
			const result = await Notification.requestPermission();
			setPermission(result as Permission);
			if (result === "granted") {
				setBrowserNotificationsEnabled(true);
				setMuted(false);
			}
		} catch {
			setPermission(readPermission());
		} finally {
			setPermissionBusy(false);
		}
	}

	async function togglePush() {
		setPushBusy(true);
		setPushError(false);
		try {
			if (isPushSubscribed) {
				await unsubscribeFromPush();
				setPushSubscribed(false);
			} else {
				await subscribeToPush();
				setPushSubscribed(true);
			}
		} catch {
			setPushError(true);
		} finally {
			setPushBusy(false);
		}
	}

	function toggleMuted() {
		const next = !muted;
		setMuted(next);
		setBrowserNotificationsEnabled(!next);
	}
	return (
		<>
			<SettingsEntry anchor="browser-notifications">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.browserNotifications")}
					</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.browserNotificationsDesc")}</p>

					{permission === "unsupported" ? (
						<p className="text-fg-muted text-xs">{t("settings.browserNotificationsInsecure")}</p>
					) : permission === "denied" ? (
						<p className="text-fg-muted text-xs">{t("settings.browserNotificationsBlocked")}</p>
					) : permission === "default" ? (
						<button
							type="button"
							onClick={requestPermission}
							disabled={permissionBusy}
							aria-busy={permissionBusy}
							className="min-h-11 px-4 py-2 rounded-lg border border-edge bg-raised text-fg text-sm hover:border-accent/40 transition-[border-color,transform] motion-safe:active:scale-[0.96] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
						>
							{t("settings.browserNotificationsEnable")}
						</button>
					) : (
						<label className="inline-flex items-center gap-3 cursor-pointer select-none">
							<div
								role="switch"
								aria-checked={!muted}
								aria-label={t("settings.browserNotifications")}
								tabIndex={0}
								className={`relative w-11 h-6 rounded-full transition-colors ${
									!muted ? "bg-accent" : "bg-raised border border-edge"
								}`}
								onClick={toggleMuted}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										toggleMuted();
									}
								}}
							>
								<div
									className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
										!muted ? "translate-x-5" : ""
									}`}
								/>
							</div>
							<span className="text-fg text-sm">
								{!muted ? t("settings.on") : t("settings.off")}
							</span>
						</label>
					)}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="push-notifications">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">{t("settings.pushNotifications")}</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.pushNotificationsDesc")}</p>
					{permission === "denied" ? (
						<p className="text-fg-muted text-xs">{t("settings.browserNotificationsBlocked")}</p>
					) : !readiness.ready ? (
						<p className="text-fg-muted text-xs">
							{readiness.reason === "needs-install"
								? t("settings.pushNeedsInstall")
								: readiness.reason === "insecure"
									? t("settings.pushInsecure")
									: t("settings.pushUnsupported")}
						</p>
					) : permission !== "granted" ? (
						<p className="text-fg-muted text-xs">{t("settings.pushNeedsBrowserPermission")}</p>
					) : isPushSubscribed === null ? (
						<p className="text-fg-3 text-xs" aria-live="polite">
							{t("settings.pushChecking")}
						</p>
					) : (
						<>
							<button
								type="button"
								onClick={() => void togglePush()}
								disabled={pushBusy}
								aria-busy={pushBusy}
								className="min-h-11 px-4 py-2 rounded-lg border border-edge bg-raised text-fg text-sm hover:border-accent/40 transition-[border-color,transform] motion-safe:active:scale-[0.96] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
							>
								{isPushSubscribed ? t("settings.pushDisable") : t("settings.pushEnable")}
							</button>
							{pushError && (
								<p className="text-danger text-xs mt-2" role="alert">
									{t("settings.pushError")}
								</p>
							)}
						</>
					)}
				</div>
			</SettingsEntry>
		</>
	);
}
