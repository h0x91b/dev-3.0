import { Component, type ErrorInfo, type ReactNode } from "react";
import { CordisContext } from "../plugins/react";
import type { SlotEntry } from "../plugins/slot-registry";
import { isBuiltinItem } from "../plugins/SlotItems";
import { markDecorationCrashed, type TerminalTabDecorationItem, type TerminalTabScope } from "./registry";

/** Drops one crashing decoration; the registry then stops placing it on every tab and logs it once. */
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

/** A tab's placed decorations, drawn inside the tab button. Built-ins keep their own DOM; anything else is clamped to one glyph so it cannot squeeze the name or spill over the close button. */
export function TerminalTabDecorations({ entries, scope }: { entries: readonly SlotEntry<TerminalTabDecorationItem>[]; scope: TerminalTabScope }) {
	return (
		<>
			{entries.map(({ def, ctx }) => {
				const Decoration = def.component;
				const decoration = (
					<DecorationBoundary key={def.id} def={def}>
						<CordisContext.Provider value={ctx}>
							<Decoration ctx={ctx} window={scope.window} unseen={scope.unseen} />
						</CordisContext.Provider>
					</DecorationBoundary>
				);
				if (isBuiltinItem(def.id)) return decoration;
				return (
					<span key={def.id} data-tab-decoration={def.id} className="flex flex-shrink-0 max-w-4 items-center overflow-hidden">
						{decoration}
					</span>
				);
			})}
		</>
	);
}
