import type { TaskStatus } from "../../shared/types";
import { STATUS_COLORS, STATUS_COLORS_LIGHT, STATUS_COLORS_LIGHT_INK } from "../../shared/types";
import { useResolvedTheme } from "./useResolvedTheme";

export function useStatusColors(): Record<TaskStatus, string> {
	const theme = useResolvedTheme();
	return theme === "light" ? STATUS_COLORS_LIGHT : STATUS_COLORS;
}

/**
 * Like useStatusColors, but returns values safe to use as **text ink** in
 * light theme — STATUS_COLORS_LIGHT_INK (darker variants that clear
 * APCA |Lc| ≥ 60 on the glass column header).  In dark theme the standard
 * STATUS_COLORS are used unchanged (they already work as text).
 */
export function useStatusColorsInk(): Record<TaskStatus, string> {
	const theme = useResolvedTheme();
	return theme === "light" ? STATUS_COLORS_LIGHT_INK : STATUS_COLORS;
}
