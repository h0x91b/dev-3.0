import { describe, it, expect, vi } from "vitest";

// Vitest runs under Node — bun:ffi does not resolve. Every test injects `load`.
vi.mock("bun:ffi", () => ({
	dlopen: vi.fn(() => {
		throw new Error("dlopen must not be reached in these tests");
	}),
	FFIType: {},
}));

import { createFrameSyncDisabler, GTK_FRAME_SYNC_ENV, type GtkFrameSyncCalls, type GtkFrameSyncDeps } from "../gtk-frame-sync";

const WIDGET = 0x1000;
const GDK_WINDOW = 0x2000;

function fakeCalls(overrides: Partial<GtkFrameSyncCalls> = {}): GtkFrameSyncCalls {
	return {
		gdkWindowOf: vi.fn(() => GDK_WINDOW),
		isX11Window: vi.fn(() => true),
		disableFrameSync: vi.fn(),
		...overrides,
	};
}

function deps(calls: GtkFrameSyncCalls, overrides: Partial<GtkFrameSyncDeps> = {}): GtkFrameSyncDeps {
	return { platform: "linux", env: {}, load: vi.fn(async () => calls), ...overrides };
}

describe("createFrameSyncDisabler", () => {
	it("disables frame sync on the realized X11 GdkWindow of the GTK toplevel", async () => {
		const calls = fakeCalls();
		await expect(createFrameSyncDisabler(deps(calls))(WIDGET)).resolves.toBe("disabled");
		expect(calls.gdkWindowOf).toHaveBeenCalledWith(WIDGET);
		expect(calls.disableFrameSync).toHaveBeenCalledWith(GDK_WINDOW);
	});

	it.each(["darwin", "win32"] as const)("never loads GTK on %s", async (platform) => {
		const d = deps(fakeCalls(), { platform });
		await expect(createFrameSyncDisabler(d)(WIDGET)).resolves.toBe("skipped-platform");
		expect(d.load).not.toHaveBeenCalled();
	});

	it("keeps GTK's frame sync when the env escape hatch asks for it", async () => {
		const calls = fakeCalls();
		const d = deps(calls, { env: { [GTK_FRAME_SYNC_ENV]: "on" } });
		await expect(createFrameSyncDisabler(d)(WIDGET)).resolves.toBe("kept-by-env");
		expect(calls.disableFrameSync).not.toHaveBeenCalled();
	});

	it.each([null, undefined, 0])("does nothing without a window handle (%s)", async (handle) => {
		const d = deps(fakeCalls());
		await expect(createFrameSyncDisabler(d)(handle)).resolves.toBe("no-handle");
		expect(d.load).not.toHaveBeenCalled();
	});

	it("skips a toplevel that is not realized yet", async () => {
		const calls = fakeCalls({ gdkWindowOf: vi.fn(() => 0) });
		await expect(createFrameSyncDisabler(deps(calls))(WIDGET)).resolves.toBe("not-realized");
		expect(calls.disableFrameSync).not.toHaveBeenCalled();
	});

	it("leaves a non-X11 (native Wayland) GdkWindow alone", async () => {
		const calls = fakeCalls({ isX11Window: vi.fn(() => false) });
		await expect(createFrameSyncDisabler(deps(calls))(WIDGET)).resolves.toBe("not-x11");
		expect(calls.disableFrameSync).not.toHaveBeenCalled();
	});

	it("loads GTK once for every window", async () => {
		const d = deps(fakeCalls());
		const disable = createFrameSyncDisabler(d);
		await Promise.all([disable(WIDGET), disable(WIDGET + 1), disable(WIDGET + 2)]);
		expect(d.load).toHaveBeenCalledTimes(1);
	});

	it("turns a GTK that cannot be loaded into a permanent no-op", async () => {
		const d = deps(fakeCalls(), { load: vi.fn(async () => { throw new Error("libgtk-3.so.0: cannot open"); }) });
		const disable = createFrameSyncDisabler(d);
		await expect(disable(WIDGET)).resolves.toBe("unavailable");
		await expect(disable(WIDGET)).resolves.toBe("unavailable");
		expect(d.load).toHaveBeenCalledTimes(1);
	});
});
