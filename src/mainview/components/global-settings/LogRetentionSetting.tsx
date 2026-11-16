import { useCallback, useEffect, useState } from "react";
import type { GlobalSettings } from "../../../shared/types";
import {
	LOG_RETENTION_PRESET_DAYS,
	isShorterRetention,
	logRetentionChoice,
	resolveLogRetentionDays,
	type LogRetentionChoice,
	type LogRetentionUsage,
} from "../../../shared/log-retention";
import { confirm } from "../../confirm";
import type { TFunction } from "../../i18n";
import { api } from "../../rpc";
import { formatBytesPrecise } from "../../utils/formatBytes";

async function fetchUsage(retentionDays?: number): Promise<LogRetentionUsage | null> {
	try {
		return await api.request.getLogRetentionUsage(retentionDays === undefined ? {} : { retentionDays });
	} catch {
		return null;
	}
}

/**
 * Retention of the agent message log and the notification log. Raising it never
 * deletes anything; lowering it asks first, saying how much goes (the host works
 * that out), because the host prunes both logs the moment the new value is saved.
 */
export default function LogRetentionSetting({
	t,
	globalSettings,
	loaded,
	onChange,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	/** False until the host has sent its settings; before that `globalSettings` is a placeholder, not the stored retention. */
	loaded: boolean;
	/** Saves the choice, naming the retention the user was looking at; the select stays disabled until it settles. */
	onChange: (choice: LogRetentionChoice, expectedCurrent: LogRetentionChoice) => Promise<void>;
}) {
	const [usage, setUsage] = useState<LogRetentionUsage | null>(null);
	const [pending, setPending] = useState(false);

	const reloadUsage = useCallback(async () => {
		const loaded = await fetchUsage();
		if (loaded) setUsage(loaded);
	}, []);

	// The host announces a saved settings change after it has pruned, so this
	// follows a lowered retention with the new, smaller footprint.
	useEffect(() => {
		void reloadUsage();
		window.addEventListener("rpc:globalSettingsUpdated", reloadUsage);
		return () => window.removeEventListener("rpc:globalSettingsUpdated", reloadUsage);
	}, [reloadUsage]);

	async function handleChange(raw: string) {
		if (!loaded) return;
		const choice: LogRetentionChoice = raw === "forever" ? "forever" : Number(raw);
		const nextDays = choice === "forever" ? null : choice;
		setPending(true);
		try {
			if (nextDays !== null && isShorterRetention(resolveLogRetentionDays(globalSettings), nextDays)) {
				const beyond = (await fetchUsage(nextDays))?.beyond ?? null;
				if (!beyond || beyond.days > 0) {
					const confirmed = await confirm({
						title: t("settings.logRetentionConfirmTitle"),
						message: beyond
							? t.plural("settings.logRetentionConfirmMessage", beyond.days, {
									days: String(nextDays),
									size: formatBytesPrecise(beyond.bytes),
								})
							: t("settings.logRetentionConfirmUnknown", { days: String(nextDays) }),
						confirmLabel: t("settings.logRetentionConfirmLabel"),
						danger: true,
					});
					if (!confirmed) return;
				}
			}
			await onChange(choice, logRetentionChoice(globalSettings));
		} finally {
			setPending(false);
		}
	}

	const current = logRetentionChoice(globalSettings);
	// A stored day count outside the standard list stays selectable, in order.
	const dayOptions = [...new Set([...LOG_RETENTION_PRESET_DAYS, ...(current === "forever" ? [] : [current])])].sort((a, b) => a - b);
	const usedBytes = usage?.days.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;

	return (
		<div>
			<label htmlFor="log-retention" className="block text-fg text-sm font-semibold mb-2">
				{t("settings.logRetention")}
			</label>
			<p className="text-fg-3 text-sm mb-3">{t("settings.logRetentionDesc")}</p>
			<select
				id="log-retention"
				data-testid="log-retention"
				value={loaded ? String(current) : ""}
				disabled={pending || !loaded}
				onChange={(event) => void handleChange(event.target.value)}
				className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none appearance-none"
			>
				{loaded ? (
					<>
						{dayOptions.map((days) => (
							<option key={days} value={String(days)}>
								{t.plural("settings.logRetentionOption", days)}
							</option>
						))}
						<option value="forever">{t("settings.logRetentionForever")}</option>
					</>
				) : (
					<option value="" />
				)}
			</select>
			{loaded && usage && usage.days.length > 0 ? (
				<p data-testid="log-retention-usage" className="text-fg-3 text-xs mt-2 tabular-nums">
					{t.plural("settings.logRetentionUsage", usage.days.length, { size: formatBytesPrecise(usedBytes) })}
				</p>
			) : null}
		</div>
	);
}
