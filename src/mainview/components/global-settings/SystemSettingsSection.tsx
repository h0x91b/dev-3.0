import { useState } from "react";
import type { GlobalSettings, RemoteTunnelSettings } from "../../../shared/types";
import type { UpdateChannel } from "../../../shared/update-channel";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

export default function SystemSettingsSection({
	t,
	globalSettings,
	caffeinateAvailable,
	canaryAvailable,
	onUpdateChannelChange,
	onRemoteTunnelChange,
	onRemoteSilentUpdateToggle,
	onPreventSleepToggle,
	onConfirmBeforeQuitToggle,
}: {
	t: TFunction;
	globalSettings: GlobalSettings;
	caffeinateAvailable: boolean;
	/** The canary feed carries a build for this host. False on platforms it does not publish. */
	canaryAvailable: boolean;
	onUpdateChannelChange: (channel: UpdateChannel) => void;
	onRemoteTunnelChange: (tunnel: RemoteTunnelSettings | undefined) => void;
	onRemoteSilentUpdateToggle: (enabled: boolean) => void;
	onPreventSleepToggle: (enabled: boolean) => void;
	onConfirmBeforeQuitToggle: (enabled: boolean) => void;
}) {
	return (
		<SettingsSection title={t("settings.categorySystem")} helpTopicId="settings.system">
			<SettingsEntry anchor="update-channel">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2">
						{t("settings.updateChannel")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.updateChannelDesc")}
					</p>
					<select
						value={globalSettings.updateChannel}
						onChange={(event) => onUpdateChannelChange(event.target.value as UpdateChannel)}
						disabled={!canaryAvailable}
						className={`w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none appearance-none${
							canaryAvailable ? "" : " cursor-not-allowed opacity-50"
						}`}
					>
						<option value="stable">{t("settings.updateChannelStable")}</option>
						<option value="canary">{t("settings.updateChannelCanary")}</option>
					</select>
					{!canaryAvailable ? (
						// Says WHY rather than leaving a dimmed control that reads as broken. The
						// channel publishes per platform, and this machine is not one of them yet.
						<p className="text-fg-muted text-xs mt-2">{t("settings.updateChannelUnavailableHere")}</p>
					) : null}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="remote-tunnel">
				<div>
					<label htmlFor="remote-tunnel-provider" className="block text-fg text-sm font-semibold mb-2">
						{t("settings.remoteTunnel")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.remoteTunnelDesc")}
					</p>
					<select
						id="remote-tunnel-provider"
						data-testid="remote-tunnel-provider"
						value={globalSettings.remoteTunnel?.provider === "custom" ? "custom" : "cloudflare"}
						onChange={(event) =>
							onRemoteTunnelChange(
								event.target.value === "custom"
									? { provider: "custom", command: globalSettings.remoteTunnel?.command ?? "" }
									: undefined,
							)
						}
						className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm outline-none appearance-none"
					>
						<option value="cloudflare">{t("settings.remoteTunnelCloudflare")}</option>
						<option value="custom">{t("settings.remoteTunnelCustom")}</option>
					</select>
					{globalSettings.remoteTunnel?.provider === "custom" ? (
						<CustomTunnelFields t={t} tunnel={globalSettings.remoteTunnel} onChange={onRemoteTunnelChange} />
					) : null}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="remote-silent-update">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.remoteSilentUpdate")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.remoteSilentUpdateDesc")}
					</p>
					<SettingsToggle
						checked={globalSettings.remoteSilentUpdate !== false}
						ariaLabel={t("settings.remoteSilentUpdate")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() => onRemoteSilentUpdateToggle(globalSettings.remoteSilentUpdate === false)}
					/>
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="prevent-sleep">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.preventSleep")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.preventSleepDesc")}
					</p>
					<SettingsToggle
						checked={
							globalSettings.preventSleepWhileRunning !== false &&
							caffeinateAvailable
						}
						disabled={!caffeinateAvailable}
						ariaLabel={t("settings.preventSleep")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onPreventSleepToggle(
								globalSettings.preventSleepWhileRunning === false,
							)
						}
					/>
					{!caffeinateAvailable ? (
						<p className="text-fg-muted text-xs mt-2">
							{t("settings.preventSleepNotAvailable")}
						</p>
					) : null}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="confirm-before-quit">
				<div>
					<p className="block text-fg text-sm font-semibold mb-2">
						{t("settings.confirmBeforeQuit")}
					</p>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.confirmBeforeQuitDesc")}
					</p>
					<SettingsToggle
						checked={globalSettings.skipQuitDialog !== true}
						ariaLabel={t("settings.confirmBeforeQuit")}
						onLabel={t("settings.on")}
						offLabel={t("settings.off")}
						onToggle={() =>
							onConfirmBeforeQuitToggle(
								globalSettings.skipQuitDialog === true,
							)
						}
					/>
				</div>
			</SettingsEntry>
		</SettingsSection>
	);
}

/**
 * Controlled command/pattern inputs for the custom tunnel provider. Both
 * values persist together on blur from local state, so neither field can be
 * wiped by spreading a stale settings object; a blank command gets an inline
 * warning because it fails closed (no tunnel starts, no Cloudflare fallback).
 */
function CustomTunnelFields({
	t,
	tunnel,
	onChange,
}: {
	t: TFunction;
	tunnel: RemoteTunnelSettings;
	onChange: (tunnel: RemoteTunnelSettings | undefined) => void;
}) {
	const [command, setCommand] = useState(tunnel.command ?? "");
	const [urlPattern, setUrlPattern] = useState(tunnel.urlPattern ?? "");

	function persist() {
		onChange({ provider: "custom", command, urlPattern: urlPattern.trim() || undefined });
	}

	return (
		<div className="mt-3 space-y-3">
			<div>
				<label htmlFor="remote-tunnel-command" className="block text-fg-2 text-xs mb-1">
					{t("settings.remoteTunnelCommand")}
				</label>
				<input
					id="remote-tunnel-command"
					data-testid="remote-tunnel-command"
					type="text"
					value={command}
					placeholder="ngrok http {port} --log stdout"
					onChange={(event) => setCommand(event.target.value)}
					onBlur={persist}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono outline-none focus:border-accent/40 transition-colors"
				/>
				{command.trim() ? (
					<p className="text-fg-muted text-xs mt-1">{t("settings.remoteTunnelCommandHint")}</p>
				) : (
					<p data-testid="remote-tunnel-command-required" className="text-danger text-xs mt-1">
						{t("settings.remoteTunnelCommandRequired")}
					</p>
				)}
			</div>
			<div>
				<label htmlFor="remote-tunnel-url-pattern" className="block text-fg-2 text-xs mb-1">
					{t("settings.remoteTunnelUrlPattern")}
				</label>
				<input
					id="remote-tunnel-url-pattern"
					data-testid="remote-tunnel-url-pattern"
					type="text"
					value={urlPattern}
					placeholder="https://\S+\.example\.com"
					onChange={(event) => setUrlPattern(event.target.value)}
					onBlur={persist}
					className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono outline-none focus:border-accent/40 transition-colors"
				/>
				<p className="text-fg-muted text-xs mt-1">{t("settings.remoteTunnelUrlPatternHint")}</p>
			</div>
		</div>
	);
}
