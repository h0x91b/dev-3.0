import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getSelectedOpenInAppId,
	resolveSelectedOpenInApp,
	setSelectedOpenInAppId,
} from "../openInPreference";
import type { ExternalApp } from "../../shared/types";

const APPS: ExternalApp[] = [
	{ id: "finder", name: "Finder", macAppName: "Finder" },
	{ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" },
];

describe("openInPreference persistence", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("returns null before anything is selected", () => {
		expect(getSelectedOpenInAppId()).toBeNull();
	});

	it("persists and reads back the selected app id", () => {
		setSelectedOpenInAppId("vscode");
		expect(getSelectedOpenInAppId()).toBe("vscode");
	});

	it("overwrites a previous selection", () => {
		setSelectedOpenInAppId("finder");
		setSelectedOpenInAppId("vscode");
		expect(getSelectedOpenInAppId()).toBe("vscode");
	});
});

describe("resolveSelectedOpenInApp (picker fallback)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("resolves to null when no app is selected (opens the picker)", async () => {
		const getApps = vi.fn().mockResolvedValue(APPS);
		expect(await resolveSelectedOpenInApp(getApps)).toBeNull();
		// No selection → no need to even query installed apps.
		expect(getApps).not.toHaveBeenCalled();
	});

	it("resolves the selected app when it is still installed", async () => {
		setSelectedOpenInAppId("vscode");
		const app = await resolveSelectedOpenInApp(() => Promise.resolve(APPS));
		expect(app).toEqual({ id: "vscode", name: "VS Code", macAppName: "Visual Studio Code" });
	});

	it("resolves to null when the selected app was uninstalled (falls back to picker)", async () => {
		setSelectedOpenInAppId("zed");
		const app = await resolveSelectedOpenInApp(() => Promise.resolve(APPS));
		expect(app).toBeNull();
	});
});
