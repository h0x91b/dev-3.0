import type { TaskStatus } from "../../shared/types";
import { STATUS_COLORS, STATUS_COLORS_LIGHT } from "../../shared/types";
import { useResolvedTheme } from "./useResolvedTheme";

export function useStatusColors(): Record<TaskStatus, string> {
	const theme = useResolvedTheme();
	return theme === "light" ? STATUS_COLORS_LIGHT : STATUS_COLORS;
}
