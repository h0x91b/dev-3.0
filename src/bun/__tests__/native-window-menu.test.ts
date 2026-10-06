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

	it.each(["linux", "win32"] as const)("never loads anything on %s", (platform) => {
		const { adopter, load } = deps({ platform });
		adopter();
		expect(load).not.toHaveBeenCalled();
	});

	it("stays inert in headless (browser/remote) mode", () => {
		const { adopter, load } = deps({ headless: true });
		adopter();
		expect(load).not.toHaveBeenCalled();
	});

	it("is a no-op when the dylib was not bundled", () => {
		const { adopter, load } = deps({ exists: () => false });
		expect(() => adopter()).not.toThrow();
		expect(load).not.toHaveBeenCalled();
	});

	it("survives a dylib that fails to load and does not retry it", () => {
		const load = vi.fn(() => {
			throw new Error("bad image");
		});
		const { adopter } = deps({ load });
		expect(() => adopter()).not.toThrow();
		adopter();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("survives the native call throwing", () => {
		const { adopter } = deps({
			load: () => () => {
				throw new Error("boom");
			},
		});
		expect(() => adopter()).not.toThrow();
	});
});
