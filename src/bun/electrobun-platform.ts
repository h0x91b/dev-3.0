/**
 * Platform shim for Electrobun-specific APIs.
 *
 * GUI mode  (default): re-exports `Utils`, `PATHS`, `Updater` from
 *                      `electrobun/bun`.
 * Headless mode (DEV3_HEADLESS=1): replaces them with no-op stubs so we never
 *                      import `electrobun/bun` at all — that module's FFI init
 *                      calls `process.exit()` if `libNativeWrapper.dylib/so`
 *                      isn't next to the CWD, and it contains top-level
 *                      awaits that break non-GUI bundles.
 *
 * Usage contract:
 *   • GUI entry  (`src/bun/index.ts`) — runs under Electrobun shell, imports
 *     this module through handlers transitively; GUI path resolved here.
 *   • Headless entry (`src/bun/headless-entry.ts`) — reached only via
 *     `dev3 remote`, which sets DEV3_HEADLESS=1 and THEN dynamically imports
 *     headless-entry. This shim sees the flag and short-circuits to stubs,
 *     never touching `electrobun/bun`.
 *   • CLI (`src/cli/main.ts`) — must NOT import this module via any STATIC
 *     import path. `dev3 remote` boots the headless server in the same binary
 *     through a dynamic `import()`, so this shim only evaluates after
 *     DEV3_HEADLESS is set. A guard test (cli-startup-graph.test.ts) enforces
 *     that the CLI's static import graph never reaches headless-entry/electrobun.
 *
 * The top-level-await import below is safe for GUI mode: Electrobun's own
 * bundler handles it. For headless compilation we must ensure the DEV3_HEADLESS
 * env is set before this shim evaluates (the `dev3 remote` handler does that).
 */

const isHeadless = process.env.DEV3_HEADLESS === "1";

// ── Stubs ──

const stubUtils = {
	quit(): void {
		process.exit(0);
	},
	async showMessageBox(_opts: unknown): Promise<{ response: number; checkboxChecked: boolean }> {
		return { response: 1, checkboxChecked: false };
	},
	showNotification(_opts: unknown): void {},
	async openFileDialog(_opts: unknown): Promise<string[] | null> {
		return null;
	},
	openPath(_path: string): boolean {
		return false;
	},
	openExternal(_url: string): boolean {
		return false;
	},
	clipboardAvailableFormats(): string[] {
		return [];
	},
	clipboardReadImage(): Uint8Array | null {
		return null;
	},
	clipboardReadText(): string | null {
		return null;
	},
	clipboardWriteText(_text: string): void {},
	moveToTrash(_path: string): boolean {
		return false;
	},
	showItemInFolder(_path: string): boolean {
		return false;
	},
};

const stubPaths = {
	get VIEWS_FOLDER(): string {
		return process.env.DEV3_VIEWS_DIR || "";
	},
};

const stubUpdater = {
	localInfo: {
		async version(): Promise<string> {
			const m = await import("../shared/build-info.generated");
			return m.BUILD_VERSION;
		},
		async hash(): Promise<string> {
			const m = await import("../shared/build-info.generated");
			return m.BUILD_COMMIT;
		},
		async channel(): Promise<string> {
			return process.env.DEV3_CHANNEL || "prod";
		},
	},
	async checkForUpdate(): Promise<never> {
		throw new Error("Updater.checkForUpdate not available in headless mode");
	},
	async downloadUpdate(): Promise<never> {
		throw new Error("Updater.downloadUpdate not available in headless mode");
	},
	updateInfo(): null {
		return null;
	},
	async applyUpdate(): Promise<never> {
		throw new Error("Updater.applyUpdate not available in headless mode");
	},
};

// ── Exports ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Utils: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _PATHS: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Updater: any;

if (isHeadless) {
	_Utils = stubUtils;
	_PATHS = stubPaths;
	_Updater = stubUpdater;
} else {
	const ebun = await import("electrobun/bun");
	_Utils = ebun.Utils;
	_PATHS = ebun.PATHS;
	_Updater = ebun.Updater;
}

export const Utils = _Utils;
export const PATHS = _PATHS;
export const Updater = _Updater;
