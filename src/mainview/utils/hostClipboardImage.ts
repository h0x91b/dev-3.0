import { api } from "../rpc";
import { imageFilesFromClipboard } from "./clipboardImageFiles";
import { isLinux, isRemote } from "./platform";

/** Long enough for a slow clipboard owner, short enough that a stuck one does not leave the paste hanging. */
export const HOST_CLIPBOARD_TIMEOUT_MS = 10_000;

export type HostClipboardImage =
	| { kind: "image"; path: string }
	| { kind: "none" }
	| { kind: "failed"; error: unknown }
	| { kind: "timeout" };

function hasImageItem(clip: DataTransfer | null | undefined): boolean {
	const items = clip?.items;
	if (!items) return false;
	for (let i = 0; i < items.length; i++) {
		if (items[i]?.type.startsWith("image/")) return true;
	}
	return false;
}

/**
 * Whether a paste the webview delivered empty should ask the host clipboard for an image.
 *
 * WebKitGTK (the Linux desktop webview) fires a trusted paste event for a clipboard image
 * but exposes no types, items, files or text (h0x91b/dev-3.0#2041). There the host
 * clipboard IS the user's clipboard. Only a real user paste qualifies, never a script's,
 * and never in a browser tab, whose host is a different machine.
 */
export function shouldReadHostClipboardImage(event: { isTrusted?: boolean; clipboardData: DataTransfer | null }): boolean {
	if (event.isTrusted !== true || isRemote() || !isLinux()) return false;
	const clip = event.clipboardData;
	if (imageFilesFromClipboard(clip).length > 0 || hasImageItem(clip)) return false;
	return (clip?.getData("text/plain") ?? "") === "";
}

/**
 * Save the host clipboard's image into the project's uploads. `none` means the clipboard
 * holds no image, which after an empty paste is the ordinary "nothing to paste" case.
 * A reply arriving after the timeout is discarded, so the paste lands once or not at all.
 */
export function readHostClipboardImage(projectId: string, timeoutMs = HOST_CLIPBOARD_TIMEOUT_MS): Promise<HostClipboardImage> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		api.request.pasteClipboardImage({ projectId })
			.then(
				(result) => resolve(result ? { kind: "image", path: result.path } : { kind: "none" }),
				(error: unknown) => resolve({ kind: "failed", error }),
			)
			.finally(() => clearTimeout(timer));
	});
}
