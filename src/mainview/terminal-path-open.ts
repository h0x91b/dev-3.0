import type { TFunction } from "./i18n";
import { api, isElectrobun } from "./rpc";
import { toast } from "./toast";
import type { ResolvedTerminalPath, TerminalPathOpenMode } from "../shared/types";

/** App.tsx hosts the FilePreviewModal and listens for this event. */
export const OPEN_FILE_PREVIEW_EVENT = "dev3:openFilePreview";

export interface OpenFilePreviewDetail {
	path: string;
	/** 1-based line to scroll to and highlight, from a :line[:col] suffix. */
	line?: number;
	/** Owning task, so the preview's toasts can name where they came from. */
	taskId?: string;
}

export function openFilePreview(path: string, line?: number, taskId?: string): void {
	window.dispatchEvent(
		new CustomEvent<OpenFilePreviewDetail>(OPEN_FILE_PREVIEW_EVENT, { detail: { path, line, taskId } }),
	);
}

/**
 * Open a Cmd/Ctrl+Clicked terminal path per the global setting. Browser mode
 * always previews in-app: `Utils.openPath` would open the file on the HOST
 * machine, invisible to a remote user.
 */
export async function activateTerminalPath(resolved: ResolvedTerminalPath, t: TFunction, line?: number, taskId?: string): Promise<void> {
	let mode: TerminalPathOpenMode = "preview";
	if (isElectrobun) {
		try {
			mode = (await api.request.getGlobalSettings()).terminalPathOpenMode ?? "preview";
		} catch {
			// unreachable settings → preview is the safe default
		}
	}
	try {
		if (resolved.kind === "directory") {
			if (!isElectrobun) {
				toast.info(t("terminal.pathLinkFolderBrowser"), { taskId, source: "terminal" });
				return;
			}
			await api.request.openTerminalPath({
				path: resolved.path,
				mode: mode === "reveal" ? "reveal" : "system",
			});
			return;
		}
		if (mode === "preview") {
			openFilePreview(resolved.path, line, taskId);
		} else {
			await api.request.openTerminalPath({ path: resolved.path, mode });
		}
	} catch (err) {
		toast.error(t("terminal.pathLinkOpenFailed", { error: String(err) }), { taskId, source: "terminal" });
	}
}
