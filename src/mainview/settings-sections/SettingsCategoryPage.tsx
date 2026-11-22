import { useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { CordisContext } from "../plugins/react";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import { isBuiltinItem } from "../plugins/SlotItems";
import type { SlotEntry } from "../plugins/slot-registry";
import { getSettingsSectionsRegistry, type SettingsSectionItem, type SettingsSectionRegion } from "./registry";

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
 * One settings page (a category, or a Project Settings tab): its registered sections in order, each in its own error boundary.
 * A crashed built-in leaves a notice (a vanished one reads as a removed setting); an
 * extension's section simply vanishes, like any failed contributor (bible §5.12).
 */
export function SettingsCategoryPage({
	region,
	sections,
	className = "space-y-8",
}: {
	region: SettingsSectionRegion;
	sections: readonly SlotEntry<SettingsSectionItem>[];
	className?: string;
}) {
	return (
		<div className={className} data-slot="settingsSections" data-region={region}>
			{sections
				.filter((section) => section.def.region === region)
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
