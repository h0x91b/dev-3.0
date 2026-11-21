import { Component, type ErrorInfo, type ReactNode } from "react";
import { CordisContext } from "../plugins/react";
import type { SlotEntry } from "../plugins/slot-registry";
import { markDecorationCrashed, type TerminalTabDecorationItem, type TerminalTabScope } from "./registry";

/** Drops one crashing decoration everywhere and logs it once per id, not once per tab. */
class DecorationBoundary extends Component<{ def: TerminalTabDecorationItem; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: Error, _info: ErrorInfo) {
		markDecorationCrashed(this.props.def, error);
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/** A tab's placed decorations, drawn inside the tab button; no wrapper, so the built-in keeps its DOM. */
export function TerminalTabDecorations({ entries, scope }: { entries: readonly SlotEntry<TerminalTabDecorationItem>[]; scope: TerminalTabScope }) {
	return (
		<>
			{entries.map(({ def, ctx }) => {
				const Decoration = def.component;
				return (
					<DecorationBoundary key={def.id} def={def}>
						<CordisContext.Provider value={ctx}>
							<Decoration ctx={ctx} window={scope.window} unseen={scope.unseen} />
						</CordisContext.Provider>
					</DecorationBoundary>
				);
			})}
		</>
	);
}
