import { Component, useSyncExternalStore, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import type { Context } from "cordis";
import { CordisContext } from "./react";
import { failedExtensionForItem, getPluginsSnapshot, subscribePlugins } from "./runtime";
import type { SlotEntry, SlotItem } from "./slot-registry";

/** What a replace slot shows: one component, rendered under its plugin's context. */
export interface ReplaceSlotItem extends SlotItem {
	component: ComponentType<{ ctx: Context }>;
}

/** A component rendered under the context of the plugin that registered it. */
export function SlotComponent({ ctx, component: Item }: { ctx: Context; component: ComponentType<{ ctx: Context }> }) {
	return (
		<CordisContext.Provider value={ctx}>
			<Item ctx={ctx} />
		</CordisContext.Provider>
	);
}

interface BoundaryProps {
	/** Names the slot in the console. */
	slot: string;
	/** A new key resets the boundary: picking another item is a retry. */
	resetKey: string;
	fallback: (error: Error) => ReactNode;
	children: ReactNode;
}

/** Catches one slot item's render error and shows `fallback` instead, until `resetKey` changes. */
export class SlotErrorBoundary extends Component<BoundaryProps, { error: Error | null; resetKey: string }> {
	state = { error: null as Error | null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	static getDerivedStateFromProps(props: BoundaryProps, state: { error: Error | null; resetKey: string }) {
		return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`[slots] ${this.props.slot} item ${this.props.resetKey} crashed:`, error, info.componentStack);
	}

	render() {
		return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
	}
}

function SlotNotice({ children, action }: { children: ReactNode; action?: { label: string; onClick: () => void } }) {
	return (
		<div role="alert" className="mx-6 mt-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-xs flex items-center gap-3">
			<span>{children}</span>
			{action && (
				<button type="button" onClick={action.onClick} className="ml-auto shrink-0 underline underline-offset-2 hover:text-fg">
					{action.label}
				</button>
			)}
		</div>
	);
}

export interface SlotHostProps<Item extends ReplaceSlotItem> {
	/** The slot's name, for the console. */
	slot: string;
	/** The item the user chose; it may not be registered (yet, or ever). */
	requestedId: string;
	/** The entry to show, or none while the built-ins have not registered yet. */
	active: SlotEntry<Item> | undefined;
	/** The undisableable built-in, shown until `active` exists and whenever it crashes. */
	fallback: ReactNode;
	/** False holds the content back (the notice still shows), e.g. while the host's data loads. */
	ready?: boolean;
	/** Shown above the fallback when the active item crashed; the saved choice stays. */
	crashedMessage: ReactNode;
	/** Shown when the requested item's extension failed to load. */
	failedMessage: (extensionName: string) => ReactNode;
	/** Where the notices send the user, e.g. the Extensions settings. */
	manageAction?: { label: string; onClick: () => void };
}

/**
 * A replace slot: exactly one implementation on screen. A crash or a failed
 * extension shows the built-in fallback under a notice and never rewrites the
 * user's choice (spec §4.1): one bad render must not change a preference.
 */
export function SlotHost<Item extends ReplaceSlotItem>({
	slot,
	requestedId,
	active,
	fallback,
	ready = true,
	crashedMessage,
	failedMessage,
	manageAction,
}: SlotHostProps<Item>) {
	const plugins = useSyncExternalStore(subscribePlugins, getPluginsSnapshot);
	const failedExtension = active?.def.id === requestedId ? null : failedExtensionForItem(plugins, requestedId);
	return (
		<>
			{failedExtension && <SlotNotice action={manageAction}>{failedMessage(failedExtension)}</SlotNotice>}
			{ready && (
				<SlotErrorBoundary
					slot={slot}
					resetKey={active?.def.id ?? ""}
					fallback={() => (
						<>
							<SlotNotice>{crashedMessage}</SlotNotice>
							{fallback}
						</>
					)}
				>
					{/* Until the built-ins register (a cold start's first frames), the fallback
					    renders as the same component type, so the hand-over keeps its state. */}
					{active ? <SlotComponent ctx={active.ctx} component={active.def.component} /> : fallback}
				</SlotErrorBoundary>
			)}
		</>
	);
}
