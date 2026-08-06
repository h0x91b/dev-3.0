import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	applyIconToWindows,
	loadAppIcon,
	resolveIconSources,
	setWindowIcon,
	type IconPair,
	type Win32IconSurface,
} from "../window-icon";

const ICONS: IconPair = { big: 4242n, small: 4243n };
const BUNDLE_ROOT = join("C:", "Users", "a", "AppData", "Local", "dev-3.0");
const EXEC_PATH = join(BUNDLE_ROOT, "bin", "bun.exe");

/** A Windows where `iconBearing` files carry an icon and `liveWindows` exist. */
function fakeWin32(options: { iconBearing?: string[]; liveWindows?: number[] } = {}) {
	const iconBearing = new Set(options.iconBearing ?? []);
	const liveWindows = new Set(options.liveWindows ?? []);
	const applied: Array<{ hwnd: number; icons: IconPair }> = [];
	const inspected: string[] = [];
	const surface: Win32IconSurface = {
		extractIcons: (exePath) => {
			inspected.push(exePath);
			return iconBearing.has(exePath) ? ICONS : null;
		},
		applyToWindow: (hwnd, icons) => {
			if (!liveWindows.has(hwnd)) return false;
			applied.push({ hwnd, icons });
			return true;
		},
	};
	return { surface, applied, inspected };
}

describe("resolveIconSources", () => {
	it("tries the running executable first, then the bundle's two executables", () => {
		expect(resolveIconSources(EXEC_PATH, BUNDLE_ROOT, join)).toEqual([
			EXEC_PATH,
			join(BUNDLE_ROOT, "bin", "bun.exe"),
			join(BUNDLE_ROOT, "bin", "launcher.exe"),
		].filter((path, index, all) => all.indexOf(path) === index));
	});

	it("keeps no duplicate when the running executable IS the bundle's bun.exe", () => {
		const sources = resolveIconSources(EXEC_PATH, BUNDLE_ROOT, join);
		expect(new Set(sources).size).toBe(sources.length);
		expect(sources).toContain(join(BUNDLE_ROOT, "bin", "launcher.exe"));
	});

	it("fails naming the caller when every candidate is empty, instead of searching nothing", () => {
		expect(() => resolveIconSources("", "", () => "")).toThrowError(/src\/bun\/window-manager\.ts/);
	});
});

describe("loadAppIcon", () => {
	it("returns the icon from the first executable that carries one", () => {
		const win32 = fakeWin32({ iconBearing: [EXEC_PATH] });
		expect(loadAppIcon([EXEC_PATH, "other.exe"], win32.surface)).toEqual(ICONS);
		expect(win32.inspected).toEqual([EXEC_PATH]);
	});

	it("falls through to a later executable when the first carries no icon", () => {
		const launcher = join(BUNDLE_ROOT, "bin", "launcher.exe");
		const win32 = fakeWin32({ iconBearing: [launcher] });
		expect(loadAppIcon([EXEC_PATH, launcher], win32.surface)).toEqual(ICONS);
		expect(win32.inspected).toEqual([EXEC_PATH, launcher]);
	});

	it("fails naming the build step when no executable carries an icon", () => {
		const win32 = fakeWin32();
		expect(() => loadAppIcon([EXEC_PATH], win32.surface)).toThrowError(/embed-windows-icons\.ts/);
	});

	it("rejects a null icon handle instead of handing WM_SETICON a value that REMOVES the icon", () => {
		const surface: Win32IconSurface = {
			extractIcons: () => ({ big: 0n, small: 0n }),
			applyToWindow: () => true,
		};
		expect(() => loadAppIcon([EXEC_PATH], surface)).toThrowError(/null icon handle/);
	});

	it("rejects a pair where only the small icon is null", () => {
		const surface: Win32IconSurface = {
			extractIcons: () => ({ big: 4242n, small: 0n }),
			applyToWindow: () => true,
		};
		expect(() => loadAppIcon([EXEC_PATH], surface)).toThrowError(/REMOVES the window's icon/);
	});

	it("fails on an empty list rather than looping zero times and reporting success", () => {
		const win32 = fakeWin32({ iconBearing: [EXEC_PATH] });
		expect(() => loadAppIcon([], win32.surface)).toThrowError(/zero times/);
	});
});

describe("applyIconToWindows", () => {
	it("hands the icon to every window handle", () => {
		const win32 = fakeWin32({ liveWindows: [11, 22] });
		applyIconToWindows([11, 22], ICONS, win32.surface);
		expect(win32.applied).toEqual([
			{ hwnd: 11, icons: ICONS },
			{ hwnd: 22, icons: ICONS },
		]);
	});

	it("fails on an empty handle list rather than decorating nothing and reporting success", () => {
		const win32 = fakeWin32({ liveWindows: [11] });
		expect(() => applyIconToWindows([], ICONS, win32.surface)).toThrowError(/no window handles/);
		expect(win32.applied).toEqual([]);
	});

	it("fails naming electrobun's HWND contract when a handle is not a live window", () => {
		const win32 = fakeWin32({ liveWindows: [11] });
		expect(() => applyIconToWindows([11, 99], ICONS, win32.surface)).toThrowError(/nativeWrapper\.cpp/);
	});
});

describe("setWindowIcon", () => {
	it("resolves the icon and applies it to the window", () => {
		const win32 = fakeWin32({ iconBearing: [EXEC_PATH], liveWindows: [7] });
		setWindowIcon(7, { execPath: EXEC_PATH, bundleRoot: BUNDLE_ROOT, joinPath: join }, win32.surface);
		expect(win32.applied).toEqual([{ hwnd: 7, icons: ICONS }]);
	});

	it("does not touch the window when no executable carries an icon", () => {
		const win32 = fakeWin32({ liveWindows: [7] });
		expect(() => setWindowIcon(7, { execPath: EXEC_PATH, bundleRoot: BUNDLE_ROOT, joinPath: join }, win32.surface)).toThrow();
		expect(win32.applied).toEqual([]);
	});
});
