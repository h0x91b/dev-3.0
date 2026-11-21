import type { Context } from "cordis";
import type { ILinkProvider, Terminal } from "ghostty-web";
import type { TFunction } from "../i18n";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";
import type { BufferRange, RowScan } from "../terminal-file-links";
import type { TouchLinkSource } from "../terminal-touch-links";

// Internal for now: no manifest kind declares `terminalLinks`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/terminal-link-providers-slot.md).
declare module "cordis" {
	interface Context {
		terminalLinks: TerminalLinksRegistry;
	}
}

/** What the host hands a provider when a terminal opens. Renderer, input and layout stay host-owned. */
export interface TerminalLinkEnv {
	term: Terminal;
	/** The terminal's container, for overlays a provider draws itself (the OSC 8 hover tooltip). */
	container: HTMLElement;
	taskId: string;
	projectId: string;
	/** The current translator: read at activation time, so a locale switch reaches open links. */
	t: () => TFunction;
	/** The URI an OSC 8 label points to, from the host's capture of the PTY stream. */
	osc8UriFor: (label: string) => string | undefined;
	/** Repaint the persistent underlines, e.g. after a background resolution landed. */
	requestUnderlineRedraw: () => void;
}

/** One provider's presence in one terminal; every part is optional. */
export interface TerminalLinkInstance {
	/** Click and hover links, handed to ghostty in the slot's `order`. */
	provider?: ILinkProvider;
	/** Ranges that get a persistent underline, read once per repaint from a shared buffer scan. */
	underlines?: (ys: number[], scan: RowScan) => BufferRange[];
	/** The tap target under a cell, for the touch link sheet (no modifier on touch). */
	touchAt?: TouchLinkSource;
	/** A `<seq:N>` / `<pr:N>` URI under a cell, for the floating preview card. */
	refAt?: (y: number, x: number) => string | undefined;
	dispose?: () => void;
}

/**
 * A kind of terminal link. `order` sets the click registration order (a later provider wins a
 * cell both claim inside an OSC 8 link); `touchOrder` and `refOrder` rank the same provider for a
 * tap and for the preview card, where the precedence differs from the click one.
 */
export interface TerminalLinkProviderDef extends SlotItem {
	order: number;
	touchOrder?: number;
	refOrder?: number;
	create: (env: TerminalLinkEnv) => TerminalLinkInstance;
}

export class TerminalLinksRegistry extends SlotRegistry<TerminalLinkProviderDef> {
	constructor(ctx: Context) {
		super(ctx, "terminalLinks", { kind: "contribute", noun: "terminal link provider" });
	}
}

export const getTerminalLinksRegistry = defineAppSlot((root) => new TerminalLinksRegistry(root));
