import { useEffect, useState } from "react";
import { CLAUDE_MODS, type ClaudeMod, type ClaudeModStatus } from "../../../shared/types";
import type { TFunction, TranslationKey } from "../../i18n";
import { api } from "../../rpc";
import { toast } from "../../toast";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

function ClaudeModRow({ t, mod }: { t: TFunction; mod: ClaudeMod }) {
	const [status, setStatus] = useState<ClaudeModStatus | null>(null);
	const [pending, setPending] = useState<"installing" | "removing" | null>(null);
	const title = t(`settings.claudeMod.${mod.id}.title` as TranslationKey);

	useEffect(() => {
		let cancelled = false;
		api.request
			.claudeModStatus({ modId: mod.id })
			.then((next) => {
				if (!cancelled) setStatus(next);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [mod.id]);

	const on = status?.installed === true && status.enabled;
	const unavailable = status !== null && !status.claudeAvailable;

	async function handleToggle() {
		const enable = !on;
		setPending(enable ? "installing" : "removing");
		try {
			const next = await api.request.claudeModSetEnabled({ modId: mod.id, enabled: enable });
			setStatus(next);
			toast.success(t(enable ? "settings.claudeModInstalled" : "settings.claudeModRemoved", { name: title }));
		} catch (err) {
			toast.error(t("settings.claudeModFailed", { name: title, error: err instanceof Error ? err.message : String(err) }));
		} finally {
			setPending(null);
		}
	}

	return (
		<div>
			<div className="flex items-baseline gap-2 mb-1">
				<span className="text-fg text-sm font-medium">{title}</span>
				<span className="text-fg-muted text-xs">{mod.source}</span>
			</div>
			<p className="text-fg-3 text-sm mb-3">{t(`settings.claudeMod.${mod.id}.desc` as TranslationKey)}</p>
			<div className="flex items-center gap-3">
				<SettingsToggle
					checked={on}
					disabled={status === null || unavailable || pending !== null}
					ariaLabel={title}
					onLabel={t("settings.on")}
					offLabel={t("settings.off")}
					onToggle={handleToggle}
				/>
				{pending ? (
					<span className="text-fg-muted text-xs">
						{t(pending === "installing" ? "settings.claudeModInstalling" : "settings.claudeModRemoving")}
					</span>
				) : on && status?.version ? (
					<span className="text-fg-muted text-xs">{t("settings.claudeModVersion", { version: status.version })}</span>
				) : null}
			</div>
			{unavailable ? <p className="text-fg-muted text-xs mt-2">{t("settings.claudeModNoCli")}</p> : null}
		</div>
	);
}

export default function ClaudeModsSection({ t }: { t: TFunction }) {
	return (
		<SettingsSection title={t("settings.claudeMods")} description={t("settings.claudeModsDesc")}>
			<SettingsEntry anchor="claude-mods">
				<div className="space-y-6">
					{CLAUDE_MODS.map((mod) => (
						<ClaudeModRow key={mod.id} t={t} mod={mod} />
					))}
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}
