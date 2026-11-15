import { isElectrobun } from "../rpc";
import { useMobile } from "./useMobile";

/** A phone-sized device viewing dev3 through browser remote mode, not the desktop shell. */
export function useMobileBrowser(): boolean {
	return useMobile() && !isElectrobun;
}
