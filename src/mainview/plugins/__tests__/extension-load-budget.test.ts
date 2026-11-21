import type { Context } from "cordis";
import { extensionViewId, type ExtensionsOverview, type InstalledExtension } from "../../../shared/extensions";
import { api } from "../../rpc";
import { getBoardViewRegistry } from "../../board-views/registry";
import { BUILTIN_PLUGINS } from "../../builtin-plugins";
import { applyBuiltinPlugins, getPluginsSnapshot, resetPluginsForTests, setExtensionImporterForTests, syncPlugins } from "../runtime";

/**
 * Load-time budget for extensions (Phase 9): N board-view extensions through the real
 * `syncPlugins` path (manifest, guard, fibers), with only the bundle import faked.
 * The ceiling is loose on purpose: it catches an order-of-magnitude regression, never noise.
 */

vi.mock("../../rpc", () => ({ api: { request: { listExtensions: vi.fn(), getExtensionSource: vi.fn(), setExtensionsEnabled: vi.fn() } } }));

const N = 100;
/** Measured ~25 ms for 100 on a dev laptop. The guard's rescan grows superlinearly (400 take ~300 ms), see docs/extensions-platform.md. */
const LOAD_CEILING_MS = 2_000;

function extension(id: string): InstalledExtension {
	return {
		id,
		status: "active",
		manifest: { id, name: id, version: "1.0.0", publisher: "P", engines: { dev3: "^1.0.0" }, main: "index.js", contributes: { boardViews: [{ id: "view", label: "View" }] } },
	};
}

function overview(extensions: InstalledExtension[]): ExtensionsOverview {
	return { enabled: true, enabledSetting: true, lockedBy: null, apiVersion: "1.0.0", disabledBuiltins: [], extensions };
}

beforeEach(() => {
	resetPluginsForTests();
	vi.mocked(api.request.getExtensionSource).mockImplementation(async ({ id }) => id);
	// Extensions load one at a time, so the n-th bundle URL belongs to the n-th extension.
	let next = 0;
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => `ext${next++}`);
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	setExtensionImporterForTests(async (url) => ({
		default: {
			name: url,
			inject: ["boardViews"],
			apply(ctx: Context) {
				ctx.boardViews.register({ id: extensionViewId(url, "view"), label: url, component: () => null, supportsNarrow: true });
			},
		},
	}));
});

afterEach(() => vi.restoreAllMocks());

it(`loads ${N} extensions next to every built-in within the budget`, async () => {
	applyBuiltinPlugins([], BUILTIN_PLUGINS);
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
	const builtinViews = getBoardViewRegistry().list().length;
	vi.mocked(api.request.listExtensions).mockResolvedValue(overview(Array.from({ length: N }, (_, i) => extension(`ext${i}`))));

	const started = performance.now();
	await syncPlugins();
	const elapsed = performance.now() - started;

	const loads = Object.values(getPluginsSnapshot().loads);
	expect(loads.filter((load) => load.state === "loaded")).toHaveLength(N);
	expect(getBoardViewRegistry().list()).toHaveLength(builtinViews + N);
	expect(elapsed).toBeLessThan(LOAD_CEILING_MS);
});
