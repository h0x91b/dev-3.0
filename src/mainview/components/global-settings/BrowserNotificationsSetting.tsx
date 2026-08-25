import { useEffect, useState } from "react";
import type { TFunction } from "../../i18n";
import { isElectrobun } from "../../rpc";
import {
	browserNotificationsEnabled,
	setBrowserNotificationsEnabled,
	webNotificationsSupported,
} from "../../utils/webNotification";
import { isSubscribed, pushReadiness, subscribeToPush, unsubscribeFromPush } from "../../utils/webPush";

type Permission = "default" | "granted" | "denied" | "unsupported";

function readPermission(): Permission {
	if (!webNotificationsSupported()) return "unsupported";
	return Notification.permission as Permission;
}

/**
 * Browser-only setting: enable/mute Web Notifications for remote mode. Hidden in
 * the desktop app (native notifications are used there). The Notification API
 * needs a secure context, so on insecure LAN URLs this surfaces a hint that
 * notifications fall back to in-app toasts.
 */
export default function BrowserNotificationsSetting({ t }: { t: TFunction }) {
	const [permission, setPermission] = useState<Permission>(() => readPermission());
	const [muted, setMuted] = useState<boolean>(() => !browserNotificationsEnabled());
	const [pushed, setPushed] = useState(false);
	const [pushBusy, setPushBusy] = useState(false);
	const [pushError, setPushError] = useState<string | null>(null);
	const readiness = pushReadiness();

	useEffect(() => {
		void isSubscribed().then(setPushed);
	}, []);

	// Re-read on focus — the user may flip the browser's site permission elsewhere.
	useEffect(() => {
		const onFocus = () => setPermission(readPermission());
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	// Desktop app uses native notifications — nothing to configure here.
	if (isElectrobun) return null;

	async function requestPermission() {
		try {
			const result = await Notification.requestPermission();
			setPermission(result as Permission);
			if (result === "granted") {
				setBrowserNotificationsEnabled(true);
				setMuted(false);
			}
		} catch {
			setPermission(readPermission());
		}
	}

	async function togglePush() {
		setPushBusy(true);
		setPushError(null);
		try {
			if (pushed) {
				await unsubscribeFromPush();
				setPushed(false);
			} else {
				await subscribeToPush();
				setPushed(true);
			}
		} catch (err) {
			setPushError(err instanceof Error ? err.message : String(err));
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
					onClick={requestPermission}
					className="px-4 py-2 rounded-xl border border-edge bg-raised text-fg text-sm hover:border-accent/40 transition-colors"
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

			{permission === "granted" && (
				<div className="mt-4 pt-4 border-t border-edge">
					<p className="block text-fg text-sm font-semibold mb-2">{t("settings.pushNotifications")}</p>
					<p className="text-fg-3 text-sm mb-3">{t("settings.pushNotificationsDesc")}</p>
					{readiness.ready ? (
						<>
							<button
								onClick={() => void togglePush()}
								disabled={pushBusy}
								className="px-4 py-2 rounded-xl border border-edge bg-raised text-fg text-sm hover:border-accent/40 transition-colors disabled:opacity-50"
							>
								{pushed ? t("settings.pushDisable") : t("settings.pushEnable")}
							</button>
							{pushError && <p className="text-danger text-xs mt-2">{pushError}</p>}
						</>
					) : (
						<p className="text-fg-muted text-xs">
							{readiness.reason === "needs-install"
								? t("settings.pushNeedsInstall")
								: readiness.reason === "insecure"
									? t("settings.pushInsecure")
									: t("settings.pushUnsupported")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
