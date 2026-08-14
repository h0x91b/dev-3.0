import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planShortcuts, shortcutFileName, type ShortcutSite, type ShortcutState } from "../shortcut-plan";
import { resolveLauncherPath } from "../index";

const IDENTIFIER = "dev3.electrobun.dev";
const LAUNCHER = "C:\\Users\\user\\AppData\\Local\\dev3.electrobun.dev\\canary\\app\\bin\\launcher.exe";
const DESKTOP_LNK = "C:\\Users\\user\\Desktop\\dev-3.0 (Canary).lnk";

function plan(sites: ShortcutSite[], state: ShortcutState = {}) {
	return planShortcuts({ sites, launcherPath: LAUNCHER, state, identifier: IDENTIFIER });
}

describe("planShortcuts", () => {
	it("creates a shortcut when none exists and we never wrote one", () => {
		const [action] = plan([{ slot: "desktop", path: DESKTOP_LNK, existingTarget: null }]);
		expect(action.kind).toBe("create");
	});

	it("never recreates a shortcut the user deleted after we wrote it", () => {
		const state: ShortcutState = { desktop: { path: DESKTOP_LNK, target: LAUNCHER } };
		const [action] = plan([{ slot: "desktop", path: DESKTOP_LNK, existingTarget: null }], state);
		expect(action.kind).toBe("skip");
		expect(action.reason).toContain("removed");
	});

	it("leaves a correct shortcut untouched", () => {
		const [action] = plan([{ slot: "desktop", path: DESKTOP_LNK, existingTarget: LAUNCHER }]);
		expect(action.kind).toBe("skip");
	});

	it("treats a differently-spelled path to the same file as correct", () => {
		const messy = "c:/Users/user/AppData/Local/dev3.electrobun.dev/canary/app/bin/LAUNCHER.EXE";
		const [action] = plan([{ slot: "desktop", path: DESKTOP_LNK, existingTarget: messy }]);
		expect(action.kind).toBe("skip");
	});

	// The disqualifying outcome this whole module exists to prevent: an update
	// moves the app and the Desktop icon stops working.
	it("repairs a shortcut that points into an old directory of ours", () => {
		const stale = "C:\\Users\\user\\AppData\\Local\\dev3.electrobun.dev\\canary\\app-1.43.0\\bin\\launcher.exe";
		const [action] = plan([{ slot: "desktop", path: DESKTOP_LNK, existingTarget: stale }]);
		expect(action.kind).toBe("repair");
	});

	it("repairs a zip user's shortcut after the app moved, because we recorded writing it", () => {
		const old = "D:\\Downloads\\dev-3.0-canary\\bin\\launcher.exe";
		const state: ShortcutState = { desktop: { path: DESKTOP_LNK, target: old } };
		const [action] = plan([{ slot: "desktop", path: DESKTOP_LNK, existingTarget: old }], state);
		expect(action.kind).toBe("repair");
	});

	it("does not clobber somebody else's shortcut with the same name", () => {
		const foreign = "C:\\Program Files\\Other App\\other.exe";
		const [action] = plan([{ slot: "desktop", path: DESKTOP_LNK, existingTarget: foreign }]);
		expect(action.kind).toBe("skip");
		expect(action.reason).toContain("unrelated");
	});

	it("plans both slots independently", () => {
		const actions = plan([
			{ slot: "desktop", path: DESKTOP_LNK, existingTarget: LAUNCHER },
			{ slot: "startMenu", path: "C:\\Users\\user\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\dev-3.0 (Canary).lnk", existingTarget: null },
		]);
		expect(actions.map((action) => action.kind)).toEqual(["skip", "create"]);
	});
});

describe("shortcutFileName", () => {
	// Byte-for-byte agreement with electrobun's windowsShortcutFileName, or a box
	// where Setup also ran ends up with two icons for one app.
	it("suffixes non-production channels the way the extractor does", () => {
		expect(shortcutFileName("dev-3.0", "canary")).toBe("dev-3.0 (Canary).lnk");
		expect(shortcutFileName("dev-3.0", "dev")).toBe("dev-3.0 (Development).lnk");
		expect(shortcutFileName("dev-3.0", "stable")).toBe("dev-3.0 (stable).lnk");
		expect(shortcutFileName("dev-3.0", "production")).toBe("dev-3.0.lnk");
	});

	it("replaces characters Windows forbids in a file name", () => {
		expect(shortcutFileName('dev:3/0*?"', "production")).toBe("dev_3_0___.lnk");
		expect(shortcutFileName("dev-3.0 ", "production")).toBe("dev-3.0.lnk");
	});
});

describe("resolveLauncherPath", () => {
	// Native separators, so this asserts the same joining the app does at runtime
	// rather than a Windows string this host cannot parse.
	it("finds launcher.exe beside the running bun.exe", () => {
		const sibling = join("app", "bin", "launcher.exe");
		expect(resolveLauncherPath(join("app", "bin", "bun.exe"), (path) => path === sibling)).toBe(sibling);
	});

	it("returns null in a development tree with no launcher", () => {
		expect(resolveLauncherPath("/usr/local/bin/bun", () => false)).toBeNull();
	});
});
