import { waitFor } from "@testing-library/react";
import type { Context } from "cordis";
import type { ExtensionsOverview, InstalledExtension } from "../../../shared/extensions";
import { api } from "../../rpc";
import { defineAppSlot, getAppRoot } from "../root";
import { SlotRegistry } from "../slot-registry";
import { getBoardViewRegistry } from "../../board-views/registry";
import {
	applyBuiltinPlugins,
	failedExtensionForItem,
	getPluginsSnapshot,
	resetPluginsForTests,
	setExtensionImporterForTests,
	restartWithExtensionsOff,
	startPlugins,
	syncPlugins,
} from "../runtime";
import type { BuiltinBoardView } from "../../board-views/builtins";

vi.mock("../../rpc", () => ({
	api: { request: { listExtensions: vi.fn(), getExtensionSource: vi.fn(), setExtensionsEnabled: vi.fn() } },
}));

declare module "cordis" {
	interface Context {
		runtimeTestSlot: SlotRegistry<{ id: string }>;
	}
}

// A second slot, so the guard is shown to watch every slot rather than only board views.
const getTestSlot = defineAppSlot((root) => new SlotRegistry<{ id: string }>(root, "runtimeTestSlot", { kind: "contribute", noun: "test item" }));

function viewPlugin(name: string, ids: string[]) {
	return {
		name,
		inject: ["board", "boardViews"],
		apply(ctx: Context) {
			for (const id of ids) ctx.boardViews.register({ id, label: id, component: () => null, supportsNarrow: true });
		},
	};
}

const builtins: BuiltinBoardView[] = [
	{ id: "builtin:kanban", labelKey: "boardView.kanban", required: true, install: (ctx) => ctx.plugin(viewPlugin("builtin:kanban", ["builtin:kanban"])) },
	{ id: "builtin:table", labelKey: "boardView.table", install: (ctx) => ctx.plugin(viewPlugin("builtin:table", ["builtin:table"])) },
];

function extension(id: string, views: string[], status: InstalledExtension["status"] = "active"): InstalledExtension {
	return {
		id,
		status,
		manifest: {
			id, name: id, version: "1.0.0", publisher: "P", engines: { dev3: "^1.0.0" }, main: "index.js",
			contributes: { boardViews: views.map((view) => ({ id: view, label: view })) },
		},
	};
}

function overview(extensions: InstalledExtension[], enabled = true): ExtensionsOverview {
	return { enabled, enabledSetting: enabled, lockedBy: null, apiVersion: "1.0.0", disabledBuiltins: [], extensions };
}

/** Each extension's "bundle" is its id; the fake importer maps it to a plugin. */
let modules: Record<string, unknown> = {};

function ids(): string[] {
	return getBoardViewRegistry().list().map((view) => view.def.id);
}

beforeEach(() => {
	resetPluginsForTests();
	modules = {};
	vi.mocked(api.request.getExtensionSource).mockClear();
	vi.mocked(api.request.getExtensionSource).mockImplementation(async ({ id }) => id);
	const sources = new Map<string, string>();
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
		const url = `blob:test/${sources.size}`;
		void (blob as Blob).text().then((text) => sources.set(url, text));
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	setExtensionImporterForTests(async (url) => {
		await new Promise((r) => setTimeout(r, 0));
		return { default: modules[sources.get(url)!] };
	});
	// A board on screen, so plugins that inject `board` start.
	getAppRoot().provide("board", {} as never);
});

describe("built-in board views", () => {
	it("keeps a built-in registered when it is disabled and re-enabled in one tick", async () => {
		applyBuiltinPlugins([], builtins);
		await waitFor(() => expect(ids()).toEqual(["builtin:kanban", "builtin:table"]));
		applyBuiltinPlugins(["builtin:table"], builtins);
		applyBuiltinPlugins([], builtins);
		await new Promise((r) => setTimeout(r, 20));
		await waitFor(() => expect(ids()).toEqual(["builtin:kanban", "builtin:table"]));
	});

	it("ignores a cached disabled list naming a built-in that cannot be disabled", async () => {
		localStorage.setItem("dev3-disabled-board-views", JSON.stringify(["builtin:kanban", "builtin:table"]));
		try {
			vi.mocked(api.request.listExtensions).mockReturnValue(new Promise(() => {}));
			startPlugins(builtins);
			await waitFor(() => expect(ids()).toEqual(["builtin:kanban"]));
		} finally {
			localStorage.removeItem("dev3-disabled-board-views");
		}
	});

	it("never disposes Kanban, whatever the disabled list says", async () => {
		applyBuiltinPlugins(["builtin:kanban", "builtin:table"], builtins);
		await waitFor(() => expect(ids()).toEqual(["builtin:kanban"]));
	});
});

describe("extension loader", () => {
	beforeEach(() => {
		applyBuiltinPlugins([], builtins);
	});

	it("loads an active extension and unloads it when the kill switch goes off", async () => {
		modules["focus-list"] = viewPlugin("focus-list", ["focus-list:focus"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("focus-list", ["focus"])]));
		await syncPlugins();
		await waitFor(() => expect(ids()).toContain("focus-list:focus"));
		expect(getPluginsSnapshot().loads["focus-list"]).toEqual({ state: "loaded" });

		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("focus-list", ["focus"])], false));
		await syncPlugins();
		await waitFor(() => expect(ids()).not.toContain("focus-list:focus"));
		expect(getPluginsSnapshot().loads["focus-list"]).toBeUndefined();
	});

	it("never runs an extension that is not active", async () => {
		modules["shady"] = viewPlugin("shady", ["shady:v"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("shady", ["v"], "untrusted")]));
		await syncPlugins();
		expect(api.request.getExtensionSource).not.toHaveBeenCalled();
	});

	it("refuses an extension registering builtin:kanban, keeps the built-in, and names the extension", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		startPlugins(builtins);
		modules["hijack"] = viewPlugin("hijack", ["builtin:kanban"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("hijack", ["kanban"])]));
		await syncPlugins();
		await waitFor(() => expect(getPluginsSnapshot().loads["hijack"]?.state).toBe("failed"));
		expect(getPluginsSnapshot().loads["hijack"]).toMatchObject({ error: expect.stringContaining("builtin:kanban") });
		const kanban = getBoardViewRegistry().get("builtin:kanban");
		expect(kanban?.ctx.fiber.name).toBe("builtin:kanban");
		expect(errors.mock.calls.some((call) => String(call[0]).includes("hijack"))).toBe(true);
		errors.mockRestore();
	});

	it("unloads an extension that registers a view its manifest does not declare, and says so in the console", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		modules["sneaky"] = viewPlugin("sneaky", ["sneaky:declared", "sneaky:extra"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("sneaky", ["declared"])]));
		await syncPlugins();
		await waitFor(() => expect(getPluginsSnapshot().loads["sneaky"]?.state).toBe("failed"));
		await waitFor(() => expect(ids().filter((id) => id.startsWith("sneaky:"))).toEqual([]));
		expect(errors.mock.calls.some((call) => String(call[0]).includes("[extensions] sneaky failed to load") && String(call[0]).includes("sneaky:extra"))).toBe(true);
		expect(failedExtensionForItem(getPluginsSnapshot(), "sneaky:declared")).toBe("sneaky");
	});

	it("unloads an extension that registers an undeclared item into any other slot", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		modules["wide"] = {
			name: "wide",
			inject: ["runtimeTestSlot"],
			apply(ctx: Context) {
				ctx.runtimeTestSlot.register({ id: "wide:item" });
			},
		};
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("wide", ["declared"])]));
		await syncPlugins();
		await waitFor(() => expect(getPluginsSnapshot().loads["wide"]).toMatchObject({ state: "failed", error: 'registered an undeclared test item "wide:item"' }));
		expect(getTestSlot().list()).toEqual([]);
		errors.mockRestore();
	});

	it("names a failed extension behind a view, and nothing for built-ins or healthy ones", () => {
		const state = {
			overview: overview([extension("focus-list", ["focus"])]),
			loads: { "focus-list": { state: "failed" as const, error: "x" }, ok: { state: "loaded" as const } },
		};
		expect(failedExtensionForItem(state, "focus-list:focus")).toBe("focus-list");
		expect(failedExtensionForItem(state, "ok:main")).toBeNull();
		expect(failedExtensionForItem(state, "builtin:table")).toBeNull();
		expect(failedExtensionForItem(state, "nocolon")).toBeNull();
	});

	it("marks a bundle without a plugin default export as failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		modules["empty"] = 42;
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("empty", ["v"])]));
		await syncPlugins();
		expect(getPluginsSnapshot().loads["empty"]).toMatchObject({ state: "failed", error: expect.stringMatching(/default-export/) });
	});

	it("Restart with extensions off: turns the kill switch off, and the next load skips extensions even if the host was unreachable", async () => {
		const reload = vi.fn();
		vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
		vi.mocked(api.request.setExtensionsEnabled).mockRejectedValue(new Error("offline"));
		await restartWithExtensionsOff();
		expect(api.request.setExtensionsEnabled).toHaveBeenCalledWith({ enabled: false });
		expect(reload).toHaveBeenCalled();

		modules["focus-list"] = viewPlugin("focus-list", ["focus-list:focus"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("focus-list", ["focus"])]));
		await syncPlugins();
		expect(api.request.getExtensionSource).not.toHaveBeenCalled();
		await syncPlugins(); // "once": a later sync loads it again
		await waitFor(() => expect(ids()).toContain("focus-list:focus"));
	});
});
