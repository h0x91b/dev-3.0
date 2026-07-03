import { useCallback, useEffect, useState } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import { CoffeeIcon, LockIcon } from "./HeaderIcons";

interface SleepState {
	enabled: boolean;
	available: boolean;
	forcedByRemote: boolean;
}

/**
 * Header toggle that keeps the machine awake while dev-3.0 is running.
 * Default on. While remote access is active it is forced on and locked,
 * since the machine must stay reachable. Hidden when no sleep-inhibit tool
 * (caffeinate / systemd-inhibit) is available on the host.
 */
function PreventSleepToggle({ compact = false }: { compact?: boolean }) {
	const t = useT();
	const [state, setState] = useState<SleepState | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(() => {
		api.request.getPreventSleepState().then(setState).catch(() => {
			// Backend may not be ready yet; leave the button hidden.
		});
	}, []);

	useEffect(() => {
		refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	if (!state || !state.available) {
		return null;
	}

	const active = state.enabled || state.forcedByRemote;
	const locked = state.forcedByRemote;

	async function toggle() {
		if (locked || busy || !state) {
			return;
		}
		const next = !state.enabled;
		setBusy(true);
		setState({ ...state, enabled: next });
		try {
			await api.request.setPreventSleep({ enabled: next });
		} catch {
			setState({ ...state, enabled: !next });
		} finally {
			setBusy(false);
		}
	}

	const title = locked
		? t("caffeine.tooltipForced")
		: active
			? t("caffeine.tooltipOn")
			: t("caffeine.tooltipOff");

	return (
		<button
			onClick={toggle}
			disabled={locked}
			aria-pressed={active}
			className={`header-anim flex items-center gap-1 transition-colors px-1.5 py-1 rounded-lg ${
				active
					? "text-awake bg-awake/15 border border-awake/30 hover:bg-awake/25"
					: "text-fg-3 hover:text-fg hover:bg-elevated border border-transparent"
			} ${locked ? "cursor-default" : ""}`}
			title={title}
		>
			{locked ? (
				<LockIcon className="w-[1.125rem] h-[1.125rem]" />
			) : (
				<CoffeeIcon className="w-[1.125rem] h-[1.125rem]" />
			)}
			{!compact && <span className="text-[0.6875rem] font-medium">{t("caffeine.label")}</span>}
		</button>
	);
}

export default PreventSleepToggle;
