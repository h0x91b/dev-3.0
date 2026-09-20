import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEV3_HOME } from "./paths";
import { withFileLock } from "./file-lock";
import { loadSettings, saveSettings } from "./settings";
import { setSimplifiedInterfaceMode } from "../shared/simplified-interface";
import {
	advanceInterfaceOnboarding, initialInterfaceOnboarding, transitionInterfaceMode,
	type InterfaceOnboardingRequest, type InterfaceOnboardingState,
} from "../shared/interface-onboarding";

const runtime = randomUUID();
const statePath = join(DEV3_HOME, "interface-onboarding.json");

export async function readInterfaceOnboarding(path: string, enabled: boolean, fresh: boolean, now: number): Promise<InterfaceOnboardingState> {
	try {
		const state = JSON.parse(await readFile(path, "utf8")) as InterfaceOnboardingState;
		if (state.version !== 1 || typeof state.enabled !== "boolean" || !Number.isFinite(state.activeMs)
			|| !Number.isFinite(state.postponements) || !["fresh", "manual", "existing"].includes(state.source)
			|| (state.dueAt !== null && !Number.isFinite(state.dueAt)) || typeof state.lessonSeen !== "boolean"
			|| typeof state.lessonPending !== "boolean") throw new Error("Invalid interface onboarding state");
		return state;
	} catch {
		return initialInterfaceOnboarding(enabled, fresh, now);
	}
}

export async function interfaceOnboarding(request: InterfaceOnboardingRequest) {
	if (!request.clientId || request.clientId.length > 128 || !["poll", "enable", "disable", "postpone", "acknowledge"].includes(request.action)) {
		throw new Error("Invalid interface onboarding request");
	}
	await mkdir(DEV3_HOME, { recursive: true });
	return withFileLock(statePath, async () => {
		const now = Date.now();
		const settings = await loadSettings();
		const state = await readInterfaceOnboarding(statePath, settings.simplifiedMode === true, settings.simplifiedModeSource === "fresh", now);
		transitionInterfaceMode(state, settings.simplifiedMode === true, now);
		const result = advanceInterfaceOnboarding(state, request, now, runtime);
		if (request.action === "enable" || request.action === "disable") {
			const next = { ...settings, ...setSimplifiedInterfaceMode(settings, result.state.enabled) };
			await saveSettings(next);
			const { getPushMessage } = await import("./rpc-handlers/shared");
			getPushMessage()?.("globalSettingsUpdated", next);
		}
		await writeFile(statePath, JSON.stringify(result.state), "utf8");
		return result.response;
	});
}

export async function noteInterfaceModeChange(previousEnabled: boolean, enabled: boolean, fresh: boolean): Promise<void> {
	if (previousEnabled === enabled) return;
	await mkdir(DEV3_HOME, { recursive: true });
	await withFileLock(statePath, async () => {
		const now = Date.now();
		const state = await readInterfaceOnboarding(statePath, previousEnabled, fresh, now);
		transitionInterfaceMode(state, enabled, now);
		await writeFile(statePath, JSON.stringify(state), "utf8");
	});
}
