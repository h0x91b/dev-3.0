import { useState, useSyncExternalStore } from "react";
import { getAppRoot } from "../plugins/root";
import { SlotComponent, SlotErrorBoundary } from "../plugins/SlotHost";
import { FILE_EXPLORER_COMPANION_ID, FileExplorerCompanion } from "./builtins";
import { ReplacementCrashedContext, TerminalCompanionPropsContext, type TerminalCompanionProps } from "./props";
import { getTerminalCompanionRegistry } from "./registry";

/**
 * A terminal with its left companion, on the `terminalCompanion` replace slot. The built-in
 * is the only option, so nothing is chosen or saved. A crashing replacement falls back to the
 * built-in, which says so in its own column (§5.12) rather than through `SlotHost`, whose notice
 * would push the terminal down. The built-in catches its own explorer crash inside that column.
 */
export function TerminalCompanion(props: TerminalCompanionProps) {
	const registry = getTerminalCompanionRegistry();
	const entries = useSyncExternalStore(registry.subscribe, registry.list);
	const active = entries.find((entry) => entry.def.id === FILE_EXPLORER_COMPANION_ID);
	// A new terminal folder is a retry, as for the explorer's own boundary.
	const resetKey = `${active?.def.id ?? ""}#${props.projectId}/${props.taskId ?? ""}`;
	const [dismissedFor, setDismissedFor] = useState<string | null>(null);
	const dismiss = () => setDismissedFor(resetKey);
	// Only a crashed replacement earns the notice: the built-in crashing is not a fallback to itself.
	const replacementCrashed = active !== undefined && active.def.component !== FileExplorerCompanion;
	const builtin = <SlotComponent ctx={getAppRoot()} component={FileExplorerCompanion} />;
	return (
		<TerminalCompanionPropsContext.Provider value={props}>
			<SlotErrorBoundary
				slot="terminalCompanion"
				resetKey={resetKey}
				fallback={() => <ReplacementCrashedContext.Provider value={replacementCrashed && dismissedFor !== resetKey ? dismiss : null}>{builtin}</ReplacementCrashedContext.Provider>}
			>
				{/* Until the built-ins register, the fallback renders as the same component type,
				    so the hand-over keeps the terminal mounted. */}
				{active ? <SlotComponent ctx={active.ctx} component={active.def.component} /> : builtin}
			</SlotErrorBoundary>
		</TerminalCompanionPropsContext.Provider>
	);
}
