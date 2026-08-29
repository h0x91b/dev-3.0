import { useCallback, useEffect, useState } from "react";
import type { RemoteAccessStatus } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";

/**
 * Live remote-access status. The app keeps booting when the server cannot bind
 * its port, so this is the only thing that tells the user it happened — and it
 * has to stay true for as long as it lasts, not fire once and vanish.
 */
export function useRemoteAccessStatus(): [RemoteAccessStatus | null, (next: RemoteAccessStatus) => void] {
	const [status, setStatus] = useState<RemoteAccessStatus | null>(null);

	useEffect(() => {
		let alive = true;
		api.request.getRemoteAccessStatus().then((next) => { if (alive) setStatus(next); }).catch(() => {});
		const onChanged = (event: Event) => setStatus((event as CustomEvent<RemoteAccessStatus>).detail);
		window.addEventListener("rpc:remoteAccessStatusChanged", onChanged);
		return () => {
			alive = false;
			window.removeEventListener("rpc:remoteAccessStatusChanged", onChanged);
		};
	}, []);

	// The setter is part of the contract: a retry that finds the server already up
	// short-circuits without firing the push, so the caller has to apply its answer.
	return [status, setStatus];
}

/**
 * Says remote access is down, why, and offers the way out. Renders nothing while
 * it is serving — a permanent "all good" row would train the eye to skip it.
 */
export default function RemoteAccessDownNotice({
	status,
	onRetry,
	onOpenSettings,
}: {
	status: RemoteAccessStatus | null;
	/** Shown as a Try again button. Settings owns this; the QR modal links out instead. */
	onRetry?: () => Promise<RemoteAccessStatus | void> | void;
	onOpenSettings?: () => void;
}) {
	const t = useT();
	const [retrying, setRetrying] = useState(false);

	const retry = useCallback(async () => {
		if (!onRetry || retrying) return;
		setRetrying(true);
		try {
			await onRetry();
		} finally {
			setRetrying(false);
		}
	}, [onRetry, retrying]);

	if (!status || status.running || !status.failure) return null;

	const { failure } = status;
	const headline = failure.reason === "port-in-use" && failure.port > 0
		? t("remote.serverDownPort", { port: String(failure.port) })
		: t("remote.serverDownOther");

	return (
		<div
			data-testid="remote-access-down"
			role="status"
			aria-live="polite"
			className="text-left space-y-2 rounded-lg bg-danger/10 border border-danger/20 px-3 py-2.5"
		>
			<div className="flex items-center gap-2">
				<div className="w-2 h-2 rounded-full bg-danger shrink-0" />
				<span className="text-danger text-xs">{headline}</span>
			</div>
			<p className="text-fg-2 text-xs leading-snug">{t("remote.serverDownHint")}</p>
			{onRetry ? (
				<button
					type="button"
					data-testid="remote-access-retry"
					disabled={retrying}
					onClick={retry}
					className="min-h-8 px-3 py-1.5 rounded-lg border border-edge text-fg-2 text-xs hover:text-fg hover:bg-elevated hover:border-edge-active disabled:opacity-60 transition-[color,background-color,border-color,transform] active:scale-[0.96]"
				>
					{retrying ? t("remote.serverRetrying") : t("remote.serverRetry")}
				</button>
			) : null}
			{onOpenSettings ? (
				<button
					type="button"
					data-testid="remote-access-down-settings-link"
					onClick={onOpenSettings}
					className="block text-xs text-accent hover:text-accent-emphasis transition-colors"
				>
					{t("remote.serverSettingsLink")}
				</button>
			) : null}
		</div>
	);
}
