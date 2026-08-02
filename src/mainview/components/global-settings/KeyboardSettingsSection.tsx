import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "../../i18n";
import type { ShortcutOverrides, TerminalKeymapPreset } from "../../../shared/types";
import {
	appShortcutsForMode,
	findConflict,
	isRemappable,
	shortcutById,
	shortcutKeysForMode,
	SHORTCUT_CATEGORY_KEY,
	SHORTCUT_CATEGORY_ORDER,
	type ShortcutSpec,
} from "../../keymap";
import { serializeBinding, type Binding } from "../../keymap-bindings";
import {
	overrideCount,
	useKeymapVersion,
	withOverride,
	withoutOverride,
} from "../../keymap-store";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import { isMac, isRemote } from "../../utils/platform";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import ShortcutRow from "./ShortcutRow";
import TerminalKeymapSetting from "./TerminalKeymapSetting";

export default function KeyboardSettingsSection({
	t,
	keymapPreset,
	onKeymapChange,
	onShortcutsChange,
}: {
	t: TFunction;
	keymapPreset: TerminalKeymapPreset;
	onKeymapChange: (preset: TerminalKeymapPreset) => void;
	onShortcutsChange: (next: ShortcutOverrides) => void;
}) {
	// Re-render on every rebind: the rows read the resolved keymap from a module
	// store, not from props.
	useKeymapVersion();
	const remote = isRemote();
	const [query, setQuery] = useState("");
	const changed = overrideCount();

	const groups = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		// Matching the combo too, so "cmd k" or just "[" finds a row — half the time
		// you remember the keys and not the wording.
		const visible = appShortcutsForMode(remote).filter((spec) => {
			if (!normalized) return true;
			const haystack = `${t(spec.descKey)} ${shortcutKeysForMode(spec, isMac(), remote)}`;
			return haystack.toLocaleLowerCase().includes(normalized);
		});
		return SHORTCUT_CATEGORY_ORDER.map((category) => ({
			category,
			specs: visible.filter((spec: ShortcutSpec) => spec.category === category),
		})).filter((group) => group.specs.length > 0);
	}, [query, remote, t]);

	const rebind = useCallback(
		(id: string, bindings: Binding[] | null) => {
			if (bindings === null) {
				onShortcutsChange(withoutOverride(id));
				return;
			}
			// Stealing a combo unbinds its previous owner rather than letting two
			// shortcuts answer one key — and says whose it was.
			let next = withOverride(id, bindings);
			for (const binding of bindings) {
				const clash = findConflict(id, binding);
				if (!clash) continue;
				const loser = shortcutById(clash.ownerId);
				if (!loser || !isRemappable(loser)) continue;
				const kept = (next[clash.ownerId] ?? loser.defaults.map(serializeBinding)).filter(
					(entry) => entry !== serializeBinding(binding),
				);
				next = { ...next, [clash.ownerId]: kept };
				if (kept.length === 0) {
					toast.info(t("keymap.edit.stolen", { name: t(loser.descKey) }));
				}
			}
			onShortcutsChange(next);
		},
		[onShortcutsChange, t],
	);

	const resetAll = useCallback(async () => {
		const ok = await confirm({
			title: t("keymap.edit.resetAllTitle"),
			message: t("keymap.edit.resetAllMessage", { count: String(overrideCount()) }),
			danger: true,
		});
		if (ok) onShortcutsChange({});
	}, [onShortcutsChange, t]);

	return (
		<SettingsSection title={t("settings.categoryKeyboard")} helpTopicId="settings.keyboard">
			<SettingsEntry anchor="app-shortcuts">
				<div>
					<label className="block text-fg text-sm font-semibold mb-2" htmlFor="shortcut-filter">
						{t("settings.appShortcuts")}
					</label>
					<p className="text-fg-3 text-sm mb-3">{t("settings.appShortcutsDesc")}</p>

					{/* Fixed-height toolbar: the changed-count and Restore all appear and
					    vanish, and a growing row would push the whole list down. */}
					<div className="flex items-center gap-2 mb-2 h-9">
						<input
							id="shortcut-filter"
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={t("keymap.edit.filterPlaceholder")}
							className="flex-1 h-9 px-3 rounded-lg bg-raised border border-edge text-fg text-sm placeholder:text-fg-muted focus:border-edge-active outline-none transition-colors"
						/>
						{changed > 0 ? (
							<>
								<span className="shrink-0 text-accent text-xs tabular-nums">
									{t("keymap.edit.changedCount", { count: String(changed) })}
								</span>
								<button
									type="button"
									onClick={resetAll}
									className="shrink-0 px-3 h-9 rounded-lg border border-danger/30 text-danger text-sm hover:bg-danger/10 outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
								>
									{t("keymap.edit.resetAll")}
								</button>
							</>
						) : null}
					</div>

					{groups.length === 0 ? (
						<p className="text-fg-muted text-sm py-4">{t("keymap.edit.noMatches")}</p>
					) : (
						groups.map(({ category, specs }) => (
							<div key={category} className="mt-5 first:mt-1">
								<h3 className="flex items-center gap-2 text-fg-3 text-[11px] font-semibold uppercase tracking-wider mb-1">
									{t(SHORTCUT_CATEGORY_KEY[category])}
									<span className="h-px flex-1 bg-edge/60" />
								</h3>
								{specs.map((spec) => (
									<ShortcutRow
										key={spec.id}
										spec={spec}
										t={t}
										remote={remote}
										onRebind={rebind}
									/>
								))}
							</div>
						))
					)}
				</div>
			</SettingsEntry>

			<SettingsEntry anchor="terminal-keymap">
				<TerminalKeymapSetting t={t} keymapPreset={keymapPreset} onKeymapChange={onKeymapChange} />
			</SettingsEntry>
		</SettingsSection>
	);
}
