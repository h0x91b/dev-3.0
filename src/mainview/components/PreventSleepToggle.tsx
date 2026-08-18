import { useCallback, useEffect, useState } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import { AwakeEyeIcon, LockIcon, SleepZzzIcon } from "./HeaderIcons";
import Tooltip from "./Tooltip";

interface SleepState {
	enabled: boolean;
	available: boolean;
	forcedByRemote: boolean;
}

/**
 * Toggle that keeps the machine awake while dev-3.0 is running. Default on, and
 * practically nobody turns it off, so it lives in the header's overflow menu
 * rather than in the bar itself. While remote access is active it is forced on and
 * locked, since the machine must stay reachable. Hidden when no sleep-inhibit tool
 * (caffeinate / systemd-inhibit) is available on the host.
 * Grey z's = sleep allowed, awake-orange eye = kept awake (plus a mini lock badge
 * while remote access forces it on).
 *
 * `variant`: `pill` is the icon-only chip used in the narrow action sheet; `row` is
 * the labelled menu row used inside the wide header's overflow menu.
 */
function PreventSleepToggle({ variant = "pill" }: { variant?: "pill" | "row" }) {
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

	const icon = (
		<span className="relative flex flex-shrink-0">
			{active ? (
				<AwakeEyeIcon className="w-[1.125rem] h-[1.125rem]" />
			) : (
				<SleepZzzIcon className="w-[1.125rem] h-[1.125rem]" />
			)}
			{locked && (
				<span className="absolute -right-1.5 -bottom-1 rounded bg-raised border border-edge p-px">
					<LockIcon className="w-2 h-2" />
				</span>
			)}
		</span>
	);

	if (variant === "row") {
		return (
			<button
				role="menuitem"
				onClick={toggle}
				aria-disabled={locked}
				aria-pressed={active}
				aria-label={t("caffeine.label")}
				title={title}
				className={`header-anim w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors hover:bg-elevated ${
					active ? "text-awake" : "text-fg-2 hover:text-fg"
				} ${locked ? "cursor-default" : ""}`}
			>
				{icon}
				<span className="text-sm">{t("caffeine.label")}</span>
			</button>
		);
	}

	return (
		<Tooltip content={t("caffeine.label")} detail={title}>
		<button
			onClick={toggle}
			aria-disabled={locked}
			aria-pressed={active}
			aria-label={t("caffeine.label")}
			className={`header-anim flex items-center transition-colors px-1.5 py-1 rounded-lg ${
				active
					? "text-awake bg-awake/15 border border-awake/30 hover:bg-awake/25"
					: "text-fg-3 hover:text-fg hover:bg-elevated border border-transparent"
			} ${locked ? "cursor-default" : ""}`}
		>
			{icon}
		</button>
		</Tooltip>
	);
}

export default PreventSleepToggle;
