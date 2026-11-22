import { createContext, useContext } from "react";
import type { FileExplorerFrameProps } from "../components/FileExplorerFrame";

/** What a host passes a companion: the terminal as `children`, its folder, and when to show. */
export type TerminalCompanionProps = Omit<FileExplorerFrameProps, "notice">;

export const TerminalCompanionPropsContext = createContext<TerminalCompanionProps | null>(null);

/** Set while the built-in stands in for a crashed replacement, until the notice is dismissed. */
export const ReplacementCrashedContext = createContext<(() => void) | null>(null);

/** The host's props, the terminal as `children` included: a companion lays itself out around it. */
export function useTerminalCompanionProps(): TerminalCompanionProps {
	const props = useContext(TerminalCompanionPropsContext);
	if (!props) throw new Error("terminal companion rendered outside any <TerminalCompanion>");
	return props;
}
