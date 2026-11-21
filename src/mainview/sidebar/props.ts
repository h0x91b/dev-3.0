import { createContext, useContext } from "react";
import type { ActiveTasksSidebarProps } from "../components/ActiveTasksSidebar";

export const SidebarPropsContext = createContext<ActiveTasksSidebarProps | null>(null);

/** The props the host passed to the sidebar slot; a sidebar reads them instead of ProjectView props. */
export function useSidebarProps(): ActiveTasksSidebarProps {
	const props = useContext(SidebarPropsContext);
	if (!props) throw new Error("sidebar rendered outside any <Sidebar>");
	return props;
}
