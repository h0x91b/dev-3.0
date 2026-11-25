import { describe, it, expect, vi } from "vitest";

vi.mock("electrobun/bun", () => ({
	PATHS: { VIEWS_FOLDER: "/fake-bundle/Resources/app/views/" },
	Utils: {},
	Updater: {},
}));

// Vitest runs under Node — bun:ffi does not resolve. Every test injects `load`.
vi.mock("bun:ffi", () => ({
	dlopen: vi.fn(() => {
		throw new Error("dlopen must not be reached in these tests");
	}),
	FFIType: { void: "void" },
}));

const { createWindowsMenuAdopter } = await import("../native-window-menu");

function deps(overrides: Partial<Parameters<typeof createWindowsMenuAdopter>[0]> = {}) {
	const native = vi.fn();
	const load = vi.fn(() => native);
	return {
		native,
		load,
		adopter: createWindowsMenuAdopter({
			platform: "darwin",
			headless: false,
			dylibPath: () => "/bundle/native/dev3-window-menu.dylib",
			exists: () => true,
			load,
			...overrides,
		}),
	};
}

describe("createWindowsMenuAdopter", () => {
	it("re-registers the Window menu on every menu rebuild, loading the shim once", () => {
		const { adopter, load, native } = deps();
		adopter();
		adopter();
		adopter();
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith("/bundle/native/dev3-window-menu.dylib");
		expect(native).toHaveBeenCalledTimes(3);
	});

	it("never loads anything on linux/win32, in headless (browser/remote) mode, or when the dylib was not bundled", () => {
		const cases: Array<[string, Partial<Parameters<typeof createWindowsMenuAdopter>[0]>]> = [
			["linux", { platform: "linux" }],
			["win32", { platform: "win32" }],
			["headless", { headless: true }],
			["no dylib", { exists: () => false }],
		];
		for (const [name, overrides] of cases) {
			const { adopter, load } = deps(overrides);
			expect(() => adopter(), name).not.toThrow();
			expect(load, name).not.toHaveBeenCalled();
		}
	});

	it("survives a dylib that fails to load (not retried) or a native call that throws", () => {
		const load = vi.fn(() => {
			throw new Error("bad image");
		});
		const { adopter } = deps({ load });
		expect(() => adopter()).not.toThrow();
		adopter();
		expect(load).toHaveBeenCalledTimes(1);

		// It also survives the native call itself throwing.
		const { adopter: throwing } = deps({
			load: () => () => {
				throw new Error("boom");
			},
		});
		expect(() => throwing()).not.toThrow();
	});
});
