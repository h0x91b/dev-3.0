import { api } from "./rpc";
import type { FilePreviewResult } from "../shared/types";
import { ATTACHMENT_ONLY_EXTS, TAB_VIEWABLE_EXTS, WINDOWS_OPEN_SAFE_EXTS, fileLinkExt } from "../shared/file-link-types";

/**
 * Browser-mode counterparts of the desktop's "Open in default app": the file
 * reaches the viewer's own browser through a server-minted `createFileLink`.
 */

/** `*.localhost` always resolves to loopback in browsers, so it means the same machine too. */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "::1";
}

let windowsHostOpen: Promise<boolean> | null = null;

/**
 * "Open on Windows" acts on the PC running WSL, so it is offered only when the
 * browser sits on that same PC — from a laptop it would open a window at home.
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

/** Documents and media only: Windows' default action RUNS scripts and programs. */
export function opensSafelyOnWindows(path: string): boolean {
	return WINDOWS_OPEN_SAFE_EXTS.has(fileLinkExt(path));
}

/** Text and images display in a tab (never a download-only type such as PDF); past the preview's size cap, the extension decides. */
export function opensInBrowserTab(path: string, preview: FilePreviewResult | null): boolean {
	const ext = fileLinkExt(path);
	if (ATTACHMENT_ONLY_EXTS.has(ext)) return false;
	if (preview?.kind === "text" || preview?.kind === "image") return true;
	return TAB_VIEWABLE_EXTS.has(ext);
}

/** The browser refused the new tab (popup blocker); callers name it so the user can allow it. */
export class PopupBlockedError extends Error {
	constructor() {
		super("The browser blocked the new tab");
		this.name = "PopupBlockedError";
	}
}

/**
 * The tab opens synchronously inside the click — after the RPC's await it would
 * be popup-blocked — and its `opener` is cut by hand, not with `noopener`, which
 * makes `window.open` return null even when the tab opened.
 */
export async function openLinkInNewTab(mintLink: () => Promise<string>): Promise<void> {
	const tab = window.open("", "_blank");
	if (!tab) throw new PopupBlockedError();
	try {
		const href = new URL(await mintLink(), window.location.href).href;
		tab.opener = null;
		tab.location.replace(href);
	} catch (err) {
		tab.close();
		throw err;
	}
}

export function openFileInNewTab(path: string): Promise<void> {
	return openLinkInNewTab(async () => (await api.request.createFileLink({ path })).url);
}

export async function downloadFile(path: string): Promise<void> {
	const { url } = await api.request.createFileLink({ path, download: true });
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = "";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
}

/** The remote stand-in for "Open in default app": a tab when the browser can show the file, a download otherwise. */
export function openFileInBrowser(path: string): Promise<void> {
	return TAB_VIEWABLE_EXTS.has(fileLinkExt(path)) ? openFileInNewTab(path) : downloadFile(path);
}

/** RPC errors arrive as Error or as a bare string; the toast wants the message either way. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
