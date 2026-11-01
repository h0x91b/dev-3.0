import { waitFor } from "@testing-library/react";
import type { Context } from "cordis";
import type { ExtensionsOverview, InstalledExtension } from "../../../shared/extensions";
import { api } from "../../rpc";
import { getBoardRoot, getBoardViewRegistry, resetBoardRootForTests } from "../root";
import {
	applyBuiltinBoardViews,
	getBoardPluginsSnapshot,
	resetBoardPluginsForTests,
	setExtensionImporterForTests,
	restartWithExtensionsOff,
	startBoardPlugins,
	syncBoardPlugins,
} from "../plugins";
import type { BuiltinBoardView } from "../builtins";

vi.mock("../../rpc", () => ({
	api: { request: { listExtensions: vi.fn(), getExtensionSource: vi.fn(), setExtensionsEnabled: vi.fn() } },
}));

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
	{ id: "builtin:kanban", labelKey: "boardView.kanban", install: (ctx) => ctx.plugin(viewPlugin("builtin:kanban", ["builtin:kanban"])) },
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
	resetBoardRootForTests();
	resetBoardPluginsForTests();
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
	getBoardRoot().provide("board", {} as never);
});

describe("built-in board views", () => {
	it("keeps a built-in registered when it is disabled and re-enabled in one tick", async () => {
		applyBuiltinBoardViews([], builtins);
		await waitFor(() => expect(ids()).toEqual(["builtin:kanban", "builtin:table"]));
		applyBuiltinBoardViews(["builtin:table"], builtins);
		applyBuiltinBoardViews([], builtins);
		await new Promise((r) => setTimeout(r, 20));
		await waitFor(() => expect(ids()).toEqual(["builtin:kanban", "builtin:table"]));
	});

	it("never disposes Kanban, whatever the disabled list says", async () => {
		applyBuiltinBoardViews(["builtin:kanban", "builtin:table"], builtins);
		await waitFor(() => expect(ids()).toEqual(["builtin:kanban"]));
	});
});

describe("extension loader", () => {
	beforeEach(() => {
		applyBuiltinBoardViews([], builtins);
	});

	it("loads an active extension and unloads it when the kill switch goes off", async () => {
		modules["focus-list"] = viewPlugin("focus-list", ["focus-list:focus"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("focus-list", ["focus"])]));
		await syncBoardPlugins();
		await waitFor(() => expect(ids()).toContain("focus-list:focus"));
		expect(getBoardPluginsSnapshot().loads["focus-list"]).toEqual({ state: "loaded" });

		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("focus-list", ["focus"])], false));
		await syncBoardPlugins();
		await waitFor(() => expect(ids()).not.toContain("focus-list:focus"));
		expect(getBoardPluginsSnapshot().loads["focus-list"]).toBeUndefined();
	});

	it("never runs an extension that is not active", async () => {
		modules["shady"] = viewPlugin("shady", ["shady:v"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("shady", ["v"], "untrusted")]));
		await syncBoardPlugins();
		expect(api.request.getExtensionSource).not.toHaveBeenCalled();
	});

	it("refuses an extension registering builtin:kanban, keeps the built-in, and names the extension", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		startBoardPlugins();
		modules["hijack"] = viewPlugin("hijack", ["builtin:kanban"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("hijack", ["kanban"])]));
		await syncBoardPlugins();
		await waitFor(() => expect(getBoardPluginsSnapshot().loads["hijack"]?.state).toBe("failed"));
		expect(getBoardPluginsSnapshot().loads["hijack"]).toMatchObject({ error: expect.stringContaining("builtin:kanban") });
		const kanban = getBoardViewRegistry().get("builtin:kanban");
		expect(kanban?.ctx.fiber.name).toBe("builtin:kanban");
		expect(errors.mock.calls.some((call) => String(call[0]).includes("hijack"))).toBe(true);
		errors.mockRestore();
	});

	it("unloads an extension that registers a view its manifest does not declare", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		modules["sneaky"] = viewPlugin("sneaky", ["sneaky:declared", "sneaky:extra"]);
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("sneaky", ["declared"])]));
		await syncBoardPlugins();
		await waitFor(() => expect(getBoardPluginsSnapshot().loads["sneaky"]?.state).toBe("failed"));
		await waitFor(() => expect(ids().filter((id) => id.startsWith("sneaky:"))).toEqual([]));
	});

	it("marks a bundle without a plugin default export as failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		modules["empty"] = 42;
		vi.mocked(api.request.listExtensions).mockResolvedValue(overview([extension("empty", ["v"])]));
		await syncBoardPlugins();
		expect(getBoardPluginsSnapshot().loads["empty"]).toMatchObject({ state: "failed", error: expect.stringMatching(/default-export/) });
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
		await syncBoardPlugins();
		expect(api.request.getExtensionSource).not.toHaveBeenCalled();
		await syncBoardPlugins(); // "once": a later sync loads it again
		await waitFor(() => expect(ids()).toContain("focus-list:focus"));
	});
});
