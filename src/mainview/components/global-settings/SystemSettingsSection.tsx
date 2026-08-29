import { useCallback, useEffect, useState } from "react";
import type { GlobalSettings, RemoteTunnelSettings } from "../../../shared/types";
import type { UpdateChannel } from "../../../shared/update-channel";
import type { TFunction } from "../../i18n";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";
import { MIN_REMOTE_STATIC_CODE_LENGTH, remoteStaticCodeError } from "../../../shared/remote-static-code";
import RemoteAccessDownNotice, { useRemoteAccessStatus } from "../RemoteAccessDownNotice";
import { api } from "../../rpc";

export default function SystemSettingsSection({
	t,
	globalSettings,
	caffeinateAvailable,
	canaryAvailable,
	onUpdateChannelChange,
	onRemoteTunnelChange,
	onRemotePortChange,
	onRemoteSilentUpdateToggle,
	onStaticAccessCodeChange,
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
	onRemotePortChange: (port: number | undefined) => void;
	onRemoteSilentUpdateToggle: (enabled: boolean) => void;
	/** Empty string clears the code. */
	onStaticAccessCodeChange: (code: string) => void;
	onPreventSleepToggle: (enabled: boolean) => void;
	onConfirmBeforeQuitToggle: (enabled: boolean) => void;
}) {
	const [remoteAccessStatus, setRemoteAccessStatus] = useRemoteAccessStatus();
	const retryRemoteAccess = useCallback(
		async () => setRemoteAccessStatus(await api.request.retryRemoteAccess()),
		[setRemoteAccessStatus],
	);

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

			{/* Not a setting, so no registry entry: a status that only exists while
			    remote access is down, sitting above the controls that fix it. */}
			<RemoteAccessDownNotice status={remoteAccessStatus} onRetry={retryRemoteAccess} />

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

			<SettingsEntry anchor="static-access-code">
				<StaticAccessCodeField
					t={t}
					value={globalSettings.staticAccessCode ?? ""}
					onChange={onStaticAccessCodeChange}
				/>
			</SettingsEntry>

			<SettingsEntry anchor="remote-port">
				<div>
					<label htmlFor="remote-port" className="block text-fg text-sm font-semibold mb-2">
						{t("settings.remotePort")}
					</label>
					<p className="text-fg-3 text-sm mb-3">
						{t("settings.remotePortDesc")}
					</p>
					<RemotePortField t={t} port={globalSettings.remotePort} onChange={onRemotePortChange} />
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

/**
 * The permanent remote-access sign-in code. Persisted on blur so a half-typed
 * value never becomes the live credential, and shown as a password field
 * because this screen gets screenshotted and screen-shared.
 *
 * Deliberately NOT a strength meter or a generator: the code is whatever the
 * owner wants it to be, and the minimum length is enforced by the host.
 */
function StaticAccessCodeField({
	t,
	value,
	onChange,
}: {
	t: TFunction;
	value: string;
	onChange: (code: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const [revealed, setRevealed] = useState(false);
	const trimmed = draft.trim();
	// The host drops a code that fails this check and falls back to QR links, so
	// saving one would produce a field that looks set and a feature that is off.
	// Same validator the CLI and the server use — the floor lives in one place.
	const problem = trimmed ? remoteStaticCodeError(trimmed) : null;

	return (
		<div>
			<label htmlFor="static-access-code" className="block text-fg text-sm font-semibold mb-2">
				{t("settings.staticAccessCode")}
			</label>
			<p className="text-fg-3 text-sm mb-3">{t("settings.staticAccessCodeDesc")}</p>
			<div className="flex items-center gap-2">
				<input
					id="static-access-code"
					data-testid="static-access-code"
					type={revealed ? "text" : "password"}
					autoComplete="off"
					value={draft}
					placeholder={t("settings.staticAccessCodePlaceholder")}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => { if (!problem) onChange(trimmed); }}
					aria-invalid={problem !== null}
					aria-describedby={problem ? "static-access-code-error" : undefined}
					className={`flex-1 px-4 py-3 bg-raised border rounded-xl text-fg text-sm font-mono outline-none transition-colors streamer-private ${
						problem ? "border-danger" : "border-edge focus:border-accent/40"
					}`}
				/>
				<button
					type="button"
					data-testid="static-access-code-reveal"
					onClick={() => setRevealed((on) => !on)}
					className="px-3 py-3 rounded-xl border border-edge text-fg-2 text-xs hover:text-fg hover:bg-elevated hover:border-edge-active transition-[color,background-color,border-color,transform] active:scale-[0.96]"
				>
					{t(revealed ? "settings.staticAccessCodeHide" : "settings.staticAccessCodeReveal")}
				</button>
			</div>
			{problem ? (
				<p id="static-access-code-error" data-testid="static-access-code-error" role="alert" className="text-danger text-xs mt-2 leading-snug">
					{t("settings.staticAccessCodeTooShort", { min: String(MIN_REMOTE_STATIC_CODE_LENGTH) })}
				</p>
			) : trimmed ? (
				<p data-testid="static-access-code-warning" className="text-warning-strong text-xs mt-2 leading-snug">
					{t("settings.staticAccessCodeTunnelWarning")}
				</p>
			) : null}
			<p className="text-fg-muted text-xs mt-2 leading-snug">{t("settings.staticAccessCodeEnvHint")}</p>
		</div>
	);
}

/**
 * The port is the one remote-access knob a Finder launch cannot be given: every
 * `DEV3_*` key is stripped out of the IMPORTED login-shell environment, so a
 * shell profile never reaches the app. Blank ⇒ a free port each launch;
 * anything outside 1-65535 is refused rather than silently persisted.
 */
function RemotePortField({
	t,
	port,
	onChange,
}: {
	t: TFunction;
	port: number | undefined;
	onChange: (port: number | undefined) => void;
}) {
	const [value, setValue] = useState(port === undefined ? "" : String(port));

	// Settings load asynchronously AFTER this mounts, and this section renders
	// unconditionally — so the initial state is "" on any route that opens
	// straight into System, and blurring would then persist undefined and unpin
	// a port that was set. Adopt the stored value whenever it arrives or changes.
	useEffect(() => {
		setValue(port === undefined ? "" : String(port));
	}, [port]);

	function persist() {
		const trimmed = value.trim();
		if (!trimmed) return onChange(undefined);
		const n = Number.parseInt(trimmed, 10);
		if (String(n) !== trimmed || n < 1 || n > 65535) {
			setValue(port === undefined ? "" : String(port)); // reject, keep what is stored
			return;
		}
		onChange(n);
	}

	return (
		<input
			id="remote-port"
			data-testid="remote-port"
			type="text"
			inputMode="numeric"
			value={value}
			placeholder={t("settings.remotePortAuto")}
			onChange={(event) => setValue(event.target.value)}
			onBlur={persist}
			className="w-full px-4 py-3 bg-raised border border-edge rounded-xl text-fg text-sm font-mono outline-none focus:border-accent/40 transition-colors"
		/>
	);
}
