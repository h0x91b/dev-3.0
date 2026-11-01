import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { KANBAN_VIEW_ID } from "../../../shared/board-view-state";
import type { ExtensionsOverview, InstalledExtension } from "../../../shared/extensions";
import type { TFunction, TranslationKey } from "../../i18n";
import { api } from "../../rpc";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import { openFolderPicker } from "../../folder-picker";
import { isRemote } from "../../utils/platform";
import { BUILTIN_BOARD_VIEWS } from "../../board-views/builtins";
import {
	clearExtensionFailure,
	getBoardPluginsSnapshot,
	subscribeBoardPlugins,
	syncBoardPlugins,
	type ExtensionLoadState,
} from "../../board-views/plugins";
import ExtensionConsentModal, { type ExtensionConsentRequest } from "./ExtensionConsentModal";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import SettingsToggle from "./SettingsToggle";

type ChipTone = "accent" | "muted" | "warning" | "danger";

const CHIP_CLASSES: Record<ChipTone, string> = {
	accent: "bg-accent/15 text-accent",
	muted: "bg-raised text-fg-3 border border-edge",
	warning: "bg-warning/15 text-warning-strong",
	danger: "bg-danger/15 text-danger",
};

function statusChip(ext: InstalledExtension, load: ExtensionLoadState | undefined, extensionsOn: boolean): { key: TranslationKey; tone: ChipTone } {
	if (ext.status === "invalid") return { key: "extensions.status.invalid", tone: "danger" };
	if (ext.status === "incompatible") return { key: "extensions.status.incompatible", tone: "warning" };
	if (ext.status === "untrusted") return { key: "extensions.status.untrusted", tone: "warning" };
	if (ext.status === "disabled") return { key: "extensions.status.disabled", tone: "muted" };
	if (!extensionsOn) return { key: "extensions.status.off", tone: "muted" };
	if (load?.state === "failed") return { key: "extensions.status.failed", tone: "danger" };
	return { key: "extensions.status.active", tone: "accent" };
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Settings → Extensions (spec §5): the kill switch first, then the built-in
 * views, then installed extensions and "Install from folder…". Remote sessions
 * see it read-only, except that they may switch extensions off (D12); the host
 * refuses the rest on its own, this only keeps the controls honest.
 */
export default function ExtensionsSettingsSection({ t }: { t: TFunction }) {
	const remote = isRemote();
	const runtime = useSyncExternalStore(subscribeBoardPlugins, getBoardPluginsSnapshot);
	const [overview, setOverview] = useState<ExtensionsOverview | null>(runtime.overview);
	const [consent, setConsent] = useState<(ExtensionConsentRequest & { onConfirm: () => Promise<void> }) | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const next = await syncBoardPlugins();
		if (next) setOverview(next);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = useCallback(async (action: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await action();
		} catch (err) {
			toast.error(t("extensions.actionFailed", { error: errorText(err) }), { source: "settings" });
		} finally {
			setBusy(false);
			await refresh();
		}
	}, [refresh, t]);

	const install = useCallback(async () => {
		const path = await openFolderPicker({ title: t("extensions.pickTitle") });
		if (!path) return;
		let inspection;
		try {
			inspection = await api.request.inspectExtension({ path });
		} catch (err) {
			toast.error(t("extensions.inspectFailed", { error: errorText(err) }), { source: "settings" });
			return;
		}
		const doInstall = (consentGiven: boolean) => run(async () => {
			clearExtensionFailure(inspection.manifest.id);
			const installed = await api.request.installExtension({ path, consent: consentGiven });
			toast.success(t("extensions.installed", { name: installed.manifest?.name ?? installed.id }), { source: "settings" });
		});
		// D10: consent only on first install (and again if the publisher changed).
		if (inspection.alreadyTrusted) {
			await doInstall(false);
			return;
		}
		setConsent({
			manifest: inspection.manifest,
			sourcePath: inspection.sourcePath,
			compatible: inspection.compatible,
			apiVersion: overview?.apiVersion ?? "",
			mode: "install",
			onConfirm: () => doInstall(true),
		});
	}, [overview?.apiVersion, run, t]);

	const remove = useCallback(async (ext: InstalledExtension) => {
		const name = ext.manifest?.name ?? ext.id;
		const ok = await confirm({
			title: t("extensions.removeConfirmTitle", { name }),
			message: t("extensions.removeConfirmMessage"),
			confirmLabel: t("extensions.remove"),
			danger: true,
		});
		if (ok) await run(() => api.request.uninstallExtension({ id: ext.id }));
	}, [run, t]);

	const extensionsOn = overview?.enabled ?? true;
	const killSwitchLocked = overview?.lockedBy === "env";
	// Remote may only move the switch towards off (D12).
	const killSwitchDisabled = busy || killSwitchLocked || (remote && !extensionsOn);
	const builtins = BUILTIN_BOARD_VIEWS;
	const extensions = overview?.extensions ?? [];

	return (
		<>
			<SettingsSection title={t("extensions.killSwitch")} description={t("extensions.killSwitchDesc")}>
				<SettingsEntry anchor="extensions-kill-switch">
					<div>
						<SettingsToggle
							checked={extensionsOn}
							disabled={killSwitchDisabled}
							ariaLabel={t("extensions.killSwitch")}
							onLabel={t("settings.on")}
							offLabel={t("settings.off")}
							onToggle={() => void run(() => api.request.setExtensionsEnabled({ enabled: !(overview?.enabledSetting ?? true) }))}
						/>
						{killSwitchLocked && <p className="text-fg-muted text-xs mt-2">{t("extensions.killSwitchLockedEnv")}</p>}
						{!killSwitchLocked && remote && !extensionsOn && (
							<p className="text-fg-muted text-xs mt-2">{t("extensions.killSwitchRemoteOnlyOff")}</p>
						)}
					</div>
				</SettingsEntry>
			</SettingsSection>

			<SettingsSection title={t("extensions.builtinsTitle")} description={t("extensions.builtinsDesc")}>
				<SettingsEntry anchor="board-view-builtins">
					<ul className="divide-y divide-edge/50 rounded-xl border border-edge" data-testid="builtin-board-views">
						{builtins.map((view) => {
							const label = t(view.labelKey);
							const isKanban = view.id === KANBAN_VIEW_ID;
							const enabled = isKanban || !(overview?.disabledBuiltins ?? []).includes(view.id);
							return (
								<li key={view.id} className="flex items-center justify-between gap-4 px-4 py-3">
									<span className="text-fg text-sm">{label}</span>
									{isKanban ? (
										<span className="text-fg-muted text-xs">{t("extensions.alwaysOn")}</span>
									) : (
										<SettingsToggle
											checked={enabled}
											disabled={busy || remote || !overview}
											ariaLabel={label}
											onLabel={t("settings.on")}
											offLabel={t("settings.off")}
											onToggle={() => void run(() => api.request.setBuiltinBoardViewEnabled({ viewId: view.id, enabled: !enabled }))}
										/>
									)}
								</li>
							);
						})}
					</ul>
				</SettingsEntry>
			</SettingsSection>

			<SettingsSection title={t("extensions.installedTitle")} description={t("extensions.installedDesc")}>
				<SettingsEntry anchor="extensions-installed">
					<div className="space-y-3">
						{extensions.length === 0 ? (
							<p className="text-fg-3 text-sm" data-testid="extensions-empty">
								{t("extensions.empty")} {t("extensions.authoringHint")}
							</p>
						) : (
							<ul className="divide-y divide-edge/50 rounded-xl border border-edge" data-testid="installed-extensions">
								{extensions.map((ext) => (
									<ExtensionRow
										key={ext.id}
										t={t}
										ext={ext}
										load={runtime.loads[ext.id]}
										extensionsOn={extensionsOn}
										readOnly={remote || busy}
										onToggle={(enabled) => run(async () => {
											clearExtensionFailure(ext.id);
											await api.request.setExtensionEnabled({ id: ext.id, enabled });
										})}
										onTrust={() => ext.manifest && setConsent({
											manifest: ext.manifest,
											compatible: ext.status !== "incompatible",
											apiVersion: overview?.apiVersion ?? "",
											mode: "trust",
											onConfirm: () => run(() => api.request.trustExtension({ id: ext.id })),
										})}
										onRemove={() => void remove(ext)}
									/>
								))}
							</ul>
						)}
						{remote ? (
							<p className="text-fg-muted text-xs">{t("extensions.remoteReadOnly")}</p>
						) : (
							<button
								type="button"
								disabled={busy}
								onClick={() => void install()}
								data-testid="extensions-install"
								className="px-3 py-1.5 text-sm rounded-lg border border-edge text-fg hover:bg-raised-hover disabled:opacity-50 transition-colors"
							>
								{t("extensions.install")}
							</button>
						)}
					</div>
				</SettingsEntry>
			</SettingsSection>

			{consent && (
				<ExtensionConsentModal
					request={consent}
					onCancel={() => setConsent(null)}
					onConfirm={() => {
						const { onConfirm } = consent;
						setConsent(null);
						void onConfirm();
					}}
				/>
			)}
		</>
	);
}

function ExtensionRow({ t, ext, load, extensionsOn, readOnly, onToggle, onTrust, onRemove }: {
	t: TFunction;
	ext: InstalledExtension;
	load: ExtensionLoadState | undefined;
	extensionsOn: boolean;
	readOnly: boolean;
	onToggle: (enabled: boolean) => void;
	onTrust: () => void;
	onRemove: () => void;
}) {
	const chip = statusChip(ext, load, extensionsOn);
	const manifest = ext.manifest;
	const name = manifest?.name ?? ext.id;
	const toggleable = ext.status === "active" || ext.status === "disabled";
	const detail = ext.problem
		?? (ext.status === "untrusted" ? t("extensions.untrustedHint") : undefined)
		?? (load?.state === "failed" && extensionsOn && ext.status === "active" ? load.error : undefined);
	return (
		<li className="px-4 py-3 space-y-1.5" data-testid={`extension-row-${ext.id}`}>
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-fg text-sm font-semibold truncate">{name}</span>
						<span className={`px-1.5 py-0.5 rounded text-xs font-medium ${CHIP_CLASSES[chip.tone]}`} data-testid="extension-status">
							{t(chip.key)}
						</span>
					</div>
					{manifest && (
						<p className="text-fg-3 text-xs truncate">
							{t("extensions.byPublisher", { publisher: manifest.publisher, version: manifest.version })}
							{" · "}
							{t("extensions.views", { views: manifest.contributes.boardViews.map((v) => v.label).join(", ") })}
						</p>
					)}
				</div>
				<div className="flex items-center gap-3">
					{ext.status === "untrusted" && !readOnly && (
						<button
							type="button"
							onClick={onTrust}
							className="px-3 py-1.5 text-sm rounded-lg border border-edge text-fg hover:bg-raised-hover transition-colors"
						>
							{t("extensions.trust")}
						</button>
					)}
					{toggleable && (
						<SettingsToggle
							checked={ext.status === "active"}
							disabled={readOnly}
							ariaLabel={t("extensions.enableAria", { name })}
							onLabel={t("settings.on")}
							offLabel={t("settings.off")}
							onToggle={() => onToggle(ext.status !== "active")}
						/>
					)}
					{!readOnly && (
						<button
							type="button"
							onClick={onRemove}
							className="px-2.5 py-1.5 text-sm rounded-lg text-danger hover:bg-danger/10 transition-colors"
						>
							{t("extensions.remove")}
						</button>
					)}
				</div>
			</div>
			{detail && <p className="text-fg-3 text-xs break-words">{detail}</p>}
		</li>
	);
}
