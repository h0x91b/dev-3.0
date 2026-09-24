import type { TFunction } from "./i18n";
import { api, isElectrobun } from "./rpc";
import { toast } from "./toast";
import { fileUriToLocalPath, safeDeepLinkUri, safeFileUri } from "./terminal-osc8-links";
import { parseDeepLink } from "../shared/deep-link";
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

/**
 * Open a `dev3://…` deep link printed in terminal output. The ids are resolved
 * against the boards first (a task lives in whichever project holds it, so this
 * crosses projects by itself), then the same in-app navigation a clicked link
 * from the OS takes. It deliberately does NOT go out to the OS handler: that
 * exists on macOS only, and bouncing through it would re-launch the app from a
 * window that is already open.
 */
export async function activateDeepLinkUri(uri: string, ctx: Osc8ActivateContext): Promise<void> {
	const { t, taskId } = ctx;
	if (!parseDeepLink(uri)) {
		toast.error(t("terminal.deepLinkBad", { uri }), { taskId, source: "terminal" });
		return;
	}
	try {
		const nav = await api.request.resolveDeepLinkNav({ url: uri });
		if (!nav) {
			toast.error(t("terminal.deepLinkNotFound", { uri }), { taskId, source: "terminal" });
			return;
		}
		window.dispatchEvent(new CustomEvent("rpc:openDeepLink", { detail: nav }));
	} catch (err) {
		toast.error(t("terminal.pathLinkOpenFailed", { error: String(err) }), { taskId, source: "terminal" });
	}
}

export interface Osc8ActivateContext {
	t: TFunction;
	taskId?: string;
	projectId?: string;
}

/**
 * Activate an OSC 8 hyperlink. Agents wrap printed file paths in `file://`
 * links (Claude Code does since FORCE_HYPERLINK=1); those open like a
 * Cmd+Clicked plain path, through the same resolve + allowed-roots gate on the
 * backend. Anything else is an external URL.
 *
 * A `file:` URI that cannot be turned into a path never reaches `window.open`:
 * it would be the dead click this whole flow exists to remove, and the desktop
 * new-window intercept forwards nothing but http(s) anyway.
 */
export async function activateOsc8Uri(uri: string, ctx: Osc8ActivateContext): Promise<void> {
	const { t, taskId, projectId } = ctx;
	// A dev3 deep link is in-app navigation, not an external open — the OSC 8
	// target and the plain-text link take the same path from here.
	if (safeDeepLinkUri(uri)) {
		await activateDeepLinkUri(uri, ctx);
		return;
	}
	const file = fileUriToLocalPath(uri);
	if (!file) {
		if (safeFileUri(uri)) {
			toast.error(t("terminal.fileLinkUnreadable", { uri }), { taskId, source: "terminal" });
			return;
		}
		window.open(uri, "_blank", "noopener,noreferrer");
		return;
	}
	try {
		const { resolved } = await api.request.resolveTerminalPaths({ taskId, projectId, paths: [file.path] });
		const target = resolved[file.path];
		if (!target) {
			toast.error(t("terminal.fileLinkNotFound", { path: file.path }), { taskId, source: "terminal" });
			return;
		}
		await activateTerminalPath(target, t, file.line, taskId);
	} catch (err) {
		toast.error(t("terminal.pathLinkOpenFailed", { error: String(err) }), { taskId, source: "terminal" });
	}
}
