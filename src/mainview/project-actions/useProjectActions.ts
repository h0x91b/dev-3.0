import { useMenuSlotEntries } from "../plugins/menu-rows";
import { isBuiltinItem } from "../plugins/SlotItems";
import { BUILTIN_PROJECT_ACTIONS } from "./builtins";
import { getProjectActionRegistry } from "./registry";

const COLD_START = BUILTIN_PROJECT_ACTIONS.map((def) => ({ def }));

/** The slot's items while `open`; until the built-ins register (a cold start's first frames), dev3's own. */
export function useProjectActionEntries(open: boolean) {
	const entries = useMenuSlotEntries(getProjectActionRegistry(), open);
	return entries.some(({ def }) => isBuiltinItem(def.id)) ? entries : [...COLD_START, ...entries];
}
