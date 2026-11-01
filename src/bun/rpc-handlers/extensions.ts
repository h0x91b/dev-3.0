import type { ExtensionInspection, ExtensionsOverview, InstalledExtension } from "../../shared/extensions";
import {
	getExtensionsOverview,
	inspectExtensionFolder,
	installExtensionFromFolder,
	readExtensionSource,
	removeExtension,
	setBuiltinBoardViewEnabled,
	setExtensionEnabled,
	setExtensionsKillSwitch,
	trustInstalledExtension,
} from "../extensions";
import { isRemoteRpcCall } from "../rpc-origin";

/**
 * D12: installing, trusting and enabling third-party code happens on the desktop
 * only. Enforced here, not by hiding buttons, so a remote session cannot do it at all.
 */
function desktopOnly(action: string): void {
	if (isRemoteRpcCall()) throw new Error(`${action} is available in the desktop app only`);
}

async function listExtensions(): Promise<ExtensionsOverview> {
	return getExtensionsOverview();
}

async function inspectExtension(params: { path: string }): Promise<ExtensionInspection> {
	desktopOnly("Installing extensions");
	return inspectExtensionFolder(params.path);
}

async function installExtension(params: { path: string; consent: boolean }): Promise<InstalledExtension> {
	desktopOnly("Installing extensions");
	return installExtensionFromFolder(params.path, params.consent);
}

async function trustExtension(params: { id: string }): Promise<InstalledExtension> {
	desktopOnly("Trusting extensions");
	return trustInstalledExtension(params.id);
}

async function setExtensionEnabledHandler(params: { id: string; enabled: boolean }): Promise<void> {
	desktopOnly("Changing extensions");
	await setExtensionEnabled(params.id, params.enabled);
}

async function setBuiltinBoardViewEnabledHandler(params: { viewId: string; enabled: boolean }): Promise<void> {
	desktopOnly("Changing board views");
	await setBuiltinBoardViewEnabled(params.viewId, params.enabled);
}

/** The one switch a remote session may move, and only towards off (D12). */
async function setExtensionsEnabled(params: { enabled: boolean }): Promise<void> {
	if (params.enabled) desktopOnly("Turning extensions on");
	await setExtensionsKillSwitch(params.enabled);
}

async function uninstallExtension(params: { id: string }): Promise<void> {
	desktopOnly("Removing extensions");
	await removeExtension(params.id);
}

/** The bundle text for the renderer's loader; the same RPC serves the desktop webview and remote browsers. */
async function getExtensionSource(params: { id: string }): Promise<string> {
	return readExtensionSource(params.id);
}

export const extensionsHandlers = {
	listExtensions,
	inspectExtension,
	installExtension,
	trustExtension,
	setExtensionEnabled: setExtensionEnabledHandler,
	setBuiltinBoardViewEnabled: setBuiltinBoardViewEnabledHandler,
	setExtensionsEnabled,
	uninstallExtension,
	getExtensionSource,
};
