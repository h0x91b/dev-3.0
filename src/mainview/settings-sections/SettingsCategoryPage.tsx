import { useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { CordisContext } from "../plugins/react";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import { isBuiltinItem } from "../plugins/SlotItems";
import type { SlotEntry } from "../plugins/slot-registry";
import type { SettingsCategoryId } from "../settings-registry";
import { getSettingsSectionsRegistry, type SettingsSectionItem } from "./registry";

/** Every registered settings section, all categories, in page order. */
export function useRegisteredSettingsSections(): readonly SlotEntry<SettingsSectionItem>[] {
	const registry = getSettingsSectionsRegistry();
	return useSyncExternalStore(registry.subscribe, registry.list);
}

function SectionCrashed() {
	const t = useT();
	return (
		<div role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
			{t("settings.sectionCrashed")}
		</div>
	);
}

/**
 * One category page: its registered sections in order, each in its own error boundary.
 * A crashed built-in leaves a notice (a vanished one reads as a removed setting); an
 * extension's section simply vanishes, like any failed contributor (bible §5.12).
 */
export function SettingsCategoryPage({
	category,
	sections,
}: {
	category: SettingsCategoryId;
	sections: readonly SlotEntry<SettingsSectionItem>[];
}) {
	return (
		<div className="space-y-8" data-slot="settingsSections" data-region={category}>
			{sections
				.filter((section) => section.def.region === category)
				.map(({ def, ctx }) => {
					const Section = def.component;
					return (
						<SlotErrorBoundary key={def.id} slot="settingsSections" resetKey={def.id} fallback={() => (isBuiltinItem(def.id) ? <SectionCrashed /> : null)}>
							<CordisContext.Provider value={ctx}>
								<Section ctx={ctx} />
							</CordisContext.Provider>
						</SlotErrorBoundary>
					);
				})}
		</div>
	);
}
