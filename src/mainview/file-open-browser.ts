import { api } from "./rpc";
import type { FilePreviewResult } from "../shared/types";

/**
 * Browser-mode counterparts of the desktop's "Open in default app": the file
 * travels to the viewer's own browser through a capability link the remote
 * server mints (`createFileLink`), instead of opening on the host machine.
 */

/** `*.localhost` always resolves to loopback in browsers, so it means the same machine too. */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "::1";
}

let windowsHostOpen: Promise<boolean> | null = null;

/**
 * "Open on Windows" opens the file on the PC running WSL, so it is offered only
 * when the browser sits on that same PC — from a laptop it would quietly open a
 * window at home.
 */
export function windowsHostOpenAvailable(hostname = window.location.hostname): Promise<boolean> {
	if (!isLoopbackHostname(hostname)) return Promise.resolve(false);
	windowsHostOpen ??= api.request.getWindowsHostOpen().then(
		(result) => result.available,
		() => {
			windowsHostOpen = null;
			return false;
		},
	);
	return windowsHostOpen;
}

/** Test hook. */
export function resetWindowsHostOpenCache(): void {
	windowsHostOpen = null;
}

const TAB_VIEWABLE_EXT = /\.(?:html?|xhtml|svg|md|markdown|txt|log|json|csv|pdf|png|jpe?g|gif|webp|avif|bmp|mp4|webm|mp3|wav|ogg)$/i;

/** Text and images always display in a tab; past the preview's size cap, the extension decides. */
export function opensInBrowserTab(path: string, preview: FilePreviewResult | null): boolean {
	if (preview?.kind === "text" || preview?.kind === "image") return true;
	return TAB_VIEWABLE_EXT.test(path);
}

/**
 * The tab is opened synchronously, inside the click, because the link arrives
 * over an async RPC and a later `window.open` would be popup-blocked. Its
 * `opener` is cut before it navigates to agent-written content — not with the
 * `noopener` feature, which makes `window.open` return null even on success.
 */
export async function openLinkInNewTab(mintLink: () => Promise<string>): Promise<void> {
	const tab = window.open("", "_blank");
	try {
		const href = new URL(await mintLink(), window.location.href).href;
		if (tab) {
			tab.opener = null;
			tab.location.replace(href);
		} else {
			window.open(href, "_blank", "noopener");
		}
	} catch (err) {
		tab?.close();
		throw err;
	}
}

export function openFileInNewTab(path: string): Promise<void> {
	return openLinkInNewTab(async () => (await api.request.createFileLink({ path })).viewUrl);
}

/** The remote stand-in for "Open in default app": a tab when the browser can show the file, a download otherwise. */
export function openFileInBrowser(path: string): Promise<void> {
	return TAB_VIEWABLE_EXT.test(path) ? openFileInNewTab(path) : downloadFile(path);
}

export async function downloadFile(path: string): Promise<void> {
	const { downloadUrl } = await api.request.createFileLink({ path });
	const anchor = document.createElement("a");
	anchor.href = downloadUrl;
	anchor.download = "";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
}
