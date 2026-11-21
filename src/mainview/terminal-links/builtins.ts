import type { Context, Fiber } from "cordis";
import { parseRefUri } from "../../shared/task-refs";
import { api } from "../rpc";
import type { BuiltinPlugin } from "../plugins/runtime";
import { cellFromMouseEvent } from "../terminal-cell-hit";
import { createDeepLinkProvider } from "../terminal-deep-links";
import { createFilePathLinkProvider } from "../terminal-file-links";
import { installOsc8HoverTooltip } from "../terminal-osc8-hover";
import { createOsc8LinkProvider } from "../terminal-osc8-links";
import { activateDeepLinkUri, activateOsc8Uri, activateTerminalPath } from "../terminal-path-open";
import { osc8TouchLink, plainUrlAt } from "../terminal-touch-links";
import type { TerminalLinkEnv, TerminalLinkProviderDef } from "./registry";
// Defines the slot before the plugin injects it.
import "./registry";

/**
 * File paths in output become Cmd/Ctrl+Click links; open behaviour is the "File path click action"
 * global setting. Every resolved path also gets a persistent underline.
 */
export const FILE_PATH_LINKS: TerminalLinkProviderDef = {
	id: "builtin:file-paths",
	order: 10,
	touchOrder: 40,
	create(env: TerminalLinkEnv) {
		const { term, taskId, projectId } = env;
		const links = createFilePathLinkProvider({
			term,
			resolvePaths: async (paths) => (await api.request.resolveTerminalPaths({ taskId, projectId, paths })).resolved,
			onActivate: (resolved, _event, line) => {
				void activateTerminalPath(resolved, env.t(), line, taskId);
			},
			onResolutionsChanged: env.requestUnderlineRedraw,
		});
		return {
			provider: links,
			underlines: (ys, scan) => links.linksForRows(ys, scan),
			touchAt: (y, x) => {
				const hit = links.linkAt(y, x);
				return hit ? { kind: "file", target: hit.target.path, open: () => void activateTerminalPath(hit.target, env.t(), hit.line, taskId) } : undefined;
			},
			dispose: () => links.dispose(),
		};
	},
};

/**
 * OSC 8 hyperlinks (agents wrap markdown links in them). ghostty underlines them on hover but cannot
 * recover the URI from wasm, so it comes from the host's stream capture. Registered after file paths:
 * inside an OSC 8 link ghostty keeps the later provider's link. Label and destination are independent,
 * so a hover tooltip shows the target before the click.
 */
export const OSC8_LINKS: TerminalLinkProviderDef = {
	id: "builtin:osc8",
	order: 20,
	touchOrder: 10,
	refOrder: 20,
	create(env: TerminalLinkEnv) {
		const { term, taskId, projectId } = env;
		const ctx = () => ({ t: env.t(), taskId, projectId });
		const links = createOsc8LinkProvider({
			getLine: (y) => term.buffer.active.getLine(y) ?? undefined,
			isRowWrapped: (y) => {
				// ghostty-web reports every scrollback row as unwrapped; return
				// "unknown" there so the provider still stitches scrolled links.
				const scrollback = Math.max(0, term.buffer.active.length - term.rows);
				if (y < scrollback) return undefined;
				return term.buffer.active.getLine(y)?.isWrapped;
			},
			uriFor: env.osc8UriFor,
			cellFromEvent: (event) => cellFromMouseEvent(term, event),
			onActivate: (uri) => {
				void activateOsc8Uri(uri, ctx());
			},
		});
		const hover = installOsc8HoverTooltip({ term, container: env.container, linkAt: links.linkAt });
		return {
			provider: links,
			touchAt: (y, x) => {
				const hit = links.linkAt(y, x);
				return hit && osc8TouchLink(hit.uri, () => void activateOsc8Uri(hit.uri, ctx()));
			},
			refAt: (y, x) => {
				const uri = links.linkAt(y, x)?.uri;
				return uri && parseRefUri(uri) ? uri : undefined;
			},
			dispose: () => hover.dispose(),
		};
	},
};

/** Bare `dev3://…` links an agent printed: ghostty's URL regex knows no custom scheme. Underlined like paths. */
export const DEEP_LINKS: TerminalLinkProviderDef = {
	id: "builtin:deep-links",
	order: 30,
	touchOrder: 20,
	refOrder: 10,
	create(env: TerminalLinkEnv) {
		const { term, taskId, projectId } = env;
		const open = (uri: string) => void activateDeepLinkUri(uri, { t: env.t(), taskId, projectId });
		const links = createDeepLinkProvider({ term, onActivate: (uri) => open(uri) });
		return {
			provider: links,
			underlines: (ys, scan) => links.linksForRows(ys, scan),
			touchAt: (y, x) => {
				const uri = links.linkAt(y, x);
				return uri ? { kind: "app", target: uri, open: () => open(uri) } : undefined;
			},
			refAt: (y, x) => {
				const uri = links.linkAt(y, x);
				return uri && parseRefUri(uri) ? uri : undefined;
			},
			dispose: () => links.dispose?.(),
		};
	},
};

/** Plain URLs are clicked by ghostty itself; touch has no modifier, so only the tap sheet needs them. */
export const PLAIN_URL_TAPS: TerminalLinkProviderDef = {
	id: "builtin:plain-urls",
	order: 40,
	touchOrder: 30,
	create({ term }: TerminalLinkEnv) {
		return {
			touchAt: (y, x) => {
				const url = plainUrlAt(term.buffer.active.getLine(y) ?? undefined, x);
				return url ? { kind: "web", target: url, open: () => void window.open(url, "_blank", "noopener,noreferrer") } : undefined;
			},
		};
	},
};

export const BUILTIN_TERMINAL_LINK_PROVIDERS = [FILE_PATH_LINKS, OSC8_LINKS, DEEP_LINKS, PLAIN_URL_TAPS];

const TERMINAL_LINKS_BUILTIN_ID = "builtin:terminal-links";

/** Required: every terminal's links come from here. */
export const BUILTIN_TERMINAL_LINKS_PLUGIN: BuiltinPlugin = {
	id: TERMINAL_LINKS_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: TERMINAL_LINKS_BUILTIN_ID,
			inject: ["terminalLinks"],
			apply(pluginCtx: Context) {
				for (const def of BUILTIN_TERMINAL_LINK_PROVIDERS) pluginCtx.terminalLinks.register(def);
			},
		});
	},
};
