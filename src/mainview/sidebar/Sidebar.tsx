import { useSyncExternalStore } from "react";
import type { ActiveTasksSidebarProps } from "../components/ActiveTasksSidebar";
import { useT } from "../i18n";
import { getAppRoot } from "../plugins/root";
import { SlotComponent, SlotHost } from "../plugins/SlotHost";
import { ACTIVE_TASKS_SIDEBAR_ID, ActiveTasksSidebarBody } from "./builtins";
import { SidebarPropsContext } from "./props";
import { getSidebarRegistry } from "./registry";

/**
 * The task view's sidebar on the `sidebar` replace slot. The built-in is the only option
 * today, so there is no chooser and nothing is saved (bible §5.12, Verdict 1).
 */
export function Sidebar(props: ActiveTasksSidebarProps) {
	const t = useT();
	const registry = getSidebarRegistry();
	const entries = useSyncExternalStore(registry.subscribe, registry.list);
	const active = entries.find((entry) => entry.def.id === ACTIVE_TASKS_SIDEBAR_ID);
	return (
		<SidebarPropsContext.Provider value={props}>
			<SlotHost
				slot="sidebar"
				requestedId={ACTIVE_TASKS_SIDEBAR_ID}
				active={active}
				fallback={<SlotComponent ctx={getAppRoot()} component={ActiveTasksSidebarBody} />}
				crashedMessage={t("sidebar.crashed")}
				failedMessage={(name) => t("sidebar.extensionFailed", { name })}
			/>
		</SidebarPropsContext.Provider>
	);
}
