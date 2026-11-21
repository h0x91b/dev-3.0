import type { ILink, ILinkProvider } from "ghostty-web";
import type { BufferRange, RowScan } from "../terminal-file-links";
import { sharedScanLinks } from "../terminal-link-underlines";
import type { TouchLink } from "../terminal-touch-links";
import { getTerminalLinksRegistry, type TerminalLinkEnv, type TerminalLinkInstance, type TerminalLinkProviderDef } from "./registry";

interface Live {
	def: TerminalLinkProviderDef;
	instance: TerminalLinkInstance;
}

export interface TerminalLinksHandle {
	/** Every provider's underline ranges for the rows, from one shared scan of the buffer. */
	underlinesForRows(absoluteRows: number[]): BufferRange[];
	touchLinkAt(y: number, x: number): TouchLink | undefined;
	refAt(y: number, x: number): string | undefined;
	dispose(): void;
}

function report(def: TerminalLinkProviderDef, what: string, error: unknown): void {
	console.error(`[terminalLinks] ${def.id} ${what} failed:`, error);
}

function guarded<T>(def: TerminalLinkProviderDef, what: string, fallback: T, run: () => T): T {
	try {
		return run();
	} catch (error) {
		report(def, what, error);
		return fallback;
	}
}

/**
 * Installs the `terminalLinks` slot into one terminal. ghostty gets ONE provider that walks a
 * snapshot of the live providers in `order` and concatenates their links — exactly what ghostty
 * does itself with several registered providers. A provider that throws contributes nothing and
 * the rest carry on. The snapshot is rebuilt only when the slot changes, never per row, keystroke
 * or frame.
 */
export function installTerminalLinks(env: TerminalLinkEnv): TerminalLinksHandle {
	const registry = getTerminalLinksRegistry();
	let clicks: Live[] = [];
	let underlineFeed: (absoluteRows: number[]) => BufferRange[] = () => [];
	let touches: Live[] = [];
	let refs: Live[] = [];
	let live: Live[] = [];
	let disposed = false;

	function disposeLive(): void {
		for (const { def, instance } of live) guarded(def, "dispose", undefined, () => instance.dispose?.());
		live = [];
	}

	function rebuild(): void {
		disposeLive();
		const defs = registry.list().map((entry) => entry.def).sort((a, b) => a.order - b.order);
		live = defs.flatMap((def) => {
			const instance = guarded<TerminalLinkInstance | null>(def, "create", null, () => def.create(env));
			return instance ? [{ def, instance }] : [];
		});
		const rank = (key: "touchOrder" | "refOrder") => (a: Live, b: Live) => (a.def[key] ?? a.def.order) - (b.def[key] ?? b.def.order);
		clicks = live.filter((entry) => entry.instance.provider);
		underlineFeed = sharedScanLinks(
			env.term,
			live.flatMap(({ def, instance }) => {
				const underlines = instance.underlines;
				if (!underlines) return [];
				return [{ linksForRows: (ys: number[], scan: RowScan) => guarded(def, "underlines", [] as BufferRange[], () => underlines(ys, scan)) }];
			}),
		);
		touches = live.filter((entry) => entry.instance.touchAt).sort(rank("touchOrder"));
		refs = live.filter((entry) => entry.instance.refAt).sort(rank("refOrder"));
		env.requestUnderlineRedraw();
	}

	const composite: ILinkProvider = {
		provideLinks(y, callback) {
			const providers = clicks;
			const links: ILink[] = [];
			let index = 0;
			const next = (): void => {
				if (index >= providers.length) {
					callback(links.length > 0 ? links : undefined);
					return;
				}
				const { def, instance } = providers[index++];
				let answered = false;
				const answer = (found: ILink[] | undefined): void => {
					if (answered || disposed) return;
					answered = true;
					if (found) links.push(...found);
					next();
				};
				try {
					instance.provider!.provideLinks(y, answer);
				} catch (error) {
					report(def, "provideLinks", error);
					answer(undefined);
				}
			};
			next();
		},
	};

	rebuild();
	const unsubscribe = registry.subscribe(() => {
		if (!disposed) rebuild();
	});
	env.term.registerLinkProvider(composite);

	return {
		underlinesForRows: (absoluteRows) => underlineFeed(absoluteRows),
		touchLinkAt(y, x) {
			for (const { def, instance } of touches) {
				const hit = guarded(def, "touchAt", undefined, () => instance.touchAt!(y, x));
				if (hit) return hit;
			}
			return undefined;
		},
		refAt(y, x) {
			for (const { def, instance } of refs) {
				const hit = guarded(def, "refAt", undefined, () => instance.refAt!(y, x));
				if (hit) return hit;
			}
			return undefined;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			disposeLive();
		},
	};
}
