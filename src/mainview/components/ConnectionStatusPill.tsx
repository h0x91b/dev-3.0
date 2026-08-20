import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";
import { isRemote } from "../utils/platform";
import { useRpcStatus } from "../hooks/useDiagnostics";
import { reconnectRpc } from "../rpc";
import type { RpcConnectionState } from "../diagnostics";

const STATE_LABEL: Record<Exclude<RpcConnectionState, "connected">, TranslationKey> = {
	connecting: "diagnostics.conn.connecting",
	authenticating: "diagnostics.conn.authenticating",
	reconnecting: "diagnostics.conn.reconnecting",
	closed: "diagnostics.conn.closed",
	"auth-failed": "diagnostics.conn.authFailed",
};

/** How long the green "Back online" confirmation stays after recovery. */
const RESTORED_VISIBLE_MS = 2_500;

/**
 * Floating connection pill — the post-boot half of {@link BootstrapScreen}.
 *
 * Once the app has rendered, a dropped remote socket used to be invisible: the
 * board kept showing stale cards and every action silently queued until the
 * 120s RPC timeout, so the app read as frozen. This pill makes the transport
 * state visible for as long as it is unhealthy, offers an immediate retry, and
 * then confirms recovery for a moment so the user knows the app is live again.
 *
 * Remote-only and conditional: the desktop bridge seeds `connected` and has its
 * own watchdog + devtools, so this adds zero chrome to the happy path.
 */
export default function ConnectionStatusPill() {
	const t = useT();
	const state = useRpcStatus();
	const [showRestored, setShowRestored] = useState(false);
	const wasUnhealthyRef = useRef(false);

	const unhealthy = state !== "connected" && state !== "auth-failed";

	useEffect(() => {
		if (unhealthy) {
			wasUnhealthyRef.current = true;
			setShowRestored(false);
			return;
		}
		if (state !== "connected" || !wasUnhealthyRef.current) return;
		wasUnhealthyRef.current = false;
		setShowRestored(true);
		const id = setTimeout(() => setShowRestored(false), RESTORED_VISIBLE_MS);
		return () => clearTimeout(id);
	}, [state, unhealthy]);

	// `auth-failed` owns the whole screen (the scan-QR panel) — no pill for it.
	if (!isRemote() || state === "auth-failed") return null;
	if (!unhealthy && !showRestored) return null;

	if (showRestored) {
		return (
			<div
				role="status"
				data-testid="connection-status-pill"
				className="flex items-center gap-2 pl-2.5 pr-3 py-2 rounded-full bg-success/15 border border-success/40 text-success shadow-lg backdrop-blur-sm"
			>
				<span className="w-2 h-2 rounded-full bg-success" />
				<span className="text-xs font-semibold whitespace-nowrap">{t("conn.pill.restored")}</span>
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() => reconnectRpc()}
			aria-label={t("conn.pill.retryAria")}
			data-testid="connection-status-pill"
			className="flex items-center gap-2 pl-2.5 pr-3 py-2 rounded-full bg-warning/15 border border-warning/40 text-warning-strong shadow-lg backdrop-blur-sm hover:bg-warning/25 transition-colors"
		>
			<span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
			<span className="text-xs font-semibold whitespace-nowrap">
				{t(STATE_LABEL[state as Exclude<RpcConnectionState, "connected">])}
			</span>
			<span className="text-warning-strong/70 text-xs whitespace-nowrap">{t("conn.pill.retry")}</span>
		</button>
	);
}
