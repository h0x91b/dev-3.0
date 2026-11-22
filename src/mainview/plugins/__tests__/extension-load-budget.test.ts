import type { Context } from "cordis";
import { extensionViewId, type ExtensionsOverview, type InstalledExtension } from "../../../shared/extensions";
import { api } from "../../rpc";
import { getBoardViewRegistry } from "../../board-views/registry";
import { BUILTIN_PLUGINS } from "../../builtin-plugins";
import { applyBuiltinPlugins, getPluginsSnapshot, resetPluginsForTests, setExtensionImporterForTests, syncPlugins } from "../runtime";

/**
 * Load-time budget for extensions (Phase 9): N board-view extensions through the real
 * `syncPlugins` path (manifest, guard, fibers), with only the bundle import faked.
 * The guard's work is counted (its passes over the board-view slot, and the items those passes
 * visit); the wall-clock ceiling is only a backstop and is deliberately loose.
 */

vi.mock("../../rpc", () => ({ api: { request: { listExtensions: vi.fn(), getExtensionSource: vi.fn(), setExtensionsEnabled: vi.fn() } } }));

const N = 100;
/** Measured ~25 ms for 100 on a dev laptop: a backstop far above that, never a timing check. */
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

	const views = getBoardViewRegistry();
	const list = views.list;
	let passes = 0;
	let visited = 0;
	vi.spyOn(views, "list").mockImplementation(() => {
		const entries = list();
		passes++;
		visited += entries.length;
		return entries;
	});

	const started = performance.now();
	await syncPlugins();
	const elapsed = performance.now() - started;

	// Two guard passes per extension today (its registration, then its load check): linear in N.
	expect(passes).toBeLessThanOrEqual(2 * N + 4);
	// Each pass rescans every item, so the items visited grow as N² (the opening-track item in
	// docs/extensions-platform.md). This pins it there: indexing by owner brings it down, worse fails.
	expect(visited).toBeLessThanOrEqual((N + builtinViews + 1) ** 2);

	const loads = Object.values(getPluginsSnapshot().loads);
	expect(loads.filter((load) => load.state === "loaded")).toHaveLength(N);
	expect(getBoardViewRegistry().list()).toHaveLength(builtinViews + N);
	expect(elapsed).toBeLessThan(LOAD_CEILING_MS);
});
