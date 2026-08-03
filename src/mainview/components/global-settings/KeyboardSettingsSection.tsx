import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "../../i18n";
import type { ShortcutOverride, ShortcutOverrides, ShortcutSlot } from "../../../shared/types";
import {
	appShortcutsForMode,
	findConflict,
	isRemappable,
	shortcutById,
	shortcutKeysForMode,
	slotDefaults,
	SHORTCUT_CATEGORY_KEY,
	SHORTCUT_CATEGORY_ORDER,
	SHORTCUT_SLOTS,
	type ShortcutSpec,
} from "../../keymap";
import { parseBinding, type Binding } from "../../keymap-bindings";
import {
	overrideCount,
	useKeymapVersion,
	withSlotOverride,
	withoutOverride,
} from "../../keymap-store";
import { confirm } from "../../confirm";
import { toast } from "../../toast";
import { isMac, isRemote } from "../../utils/platform";
import SettingsEntry from "./SettingsEntry";
import SettingsSection from "./SettingsSection";
import ShortcutRow from "./ShortcutRow";

/**
 * What `spec` would still fire on if `pending` were its override. Used to tell a
 * theft that merely dropped an alias from one that left the shortcut unusable.
 */
function bindingsAfter(spec: ShortcutSpec, pending: ShortcutOverride): Binding[] {
	return SHORTCUT_SLOTS.flatMap((slot) => {
		if (slot in pending) {
			const raw = pending[slot];
			const parsed = raw ? parseBinding(raw) : null;
			return parsed ? [parsed] : [];
		}
		return slotDefaults(spec, slot);
	});
}

export default function KeyboardSettingsSection({
	t,
	onShortcutsChange,
}: {
	t: TFunction;
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
		(id: string, slot: ShortcutSlot, binding: Binding | null) => {
			let next = withSlotOverride(id, slot, binding);
			// Stealing a combo empties the slot that held it, rather than letting two
			// shortcuts answer one key — and says whose it was.
			if (binding) {
				const clash = findConflict(id, binding);
				const loser = clash ? shortcutById(clash.ownerId) : undefined;
				if (clash && loser && isRemappable(loser)) {
					const kept = { ...(next[clash.ownerId] ?? {}), [clash.ownerSlot]: null };
					next = { ...next, [clash.ownerId]: kept };
					if (bindingsAfter(loser, kept).length === 0) {
						toast.info(t("keymap.edit.stolen", { name: t(loser.descKey) }));
					}
				}
			}
			onShortcutsChange(next);
		},
		[onShortcutsChange, t],
	);

	const reset = useCallback((id: string) => onShortcutsChange(withoutOverride(id)), [onShortcutsChange]);

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
						<p className="text-fg-3 text-sm py-4">{t("keymap.edit.noMatches")}</p>
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
										onReset={reset}
									/>
								))}
							</div>
						))
					)}
				</div>
			</SettingsEntry>

		</SettingsSection>
	);
}
