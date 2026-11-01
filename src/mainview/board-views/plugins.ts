import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import * as Cordis from "cordis";
import type { Context, Fiber } from "cordis";
import { KANBAN_VIEW_ID } from "../../shared/board-view-state";
import { extensionViewId, type ExtensionsOverview, type InstalledExtension } from "../../shared/extensions";
import { api } from "../rpc";
import { BUILTIN_BOARD_VIEWS, type BuiltinBoardView } from "./builtins";
import { getBoardRoot, getBoardViewRegistry } from "./root";

/**
 * The board-view plugin runtime: which built-ins run, and the third-party
 * extensions loaded from `~/.dev3.0/extensions` (spec §4.3). Everything here
 * applies live — toggling a view or the kill switch never needs a restart.
 */

/** `FiberState.FAILED` — an ambient const enum, so not readable under isolatedModules. */
const FIBER_FAILED = 3;
const DISABLED_BUILTINS_KEY = "dev3-disabled-board-views";
const SKIP_EXTENSIONS_ONCE_KEY = "dev3-extensions-skip-once";

export type ExtensionLoadState = { state: "loaded" } | { state: "failed"; error: string };

interface RuntimeSnapshot {
	overview: ExtensionsOverview | null;
	/** Renderer-side outcome per extension id; only extensions this window tried to run appear. */
	loads: Readonly<Record<string, ExtensionLoadState>>;
}

const builtinFibers = new Map<string, Fiber>();
const extensionFibers = new Map<string, { fiber: Fiber; declared: Set<string> }>();
let snapshot: RuntimeSnapshot = { overview: null, loads: {} };
const listeners = new Set<() => void>();
let guardInstalled = false;
let syncChain: Promise<void> = Promise.resolve();

function publish(next: Partial<RuntimeSnapshot>): void {
	snapshot = { ...snapshot, ...next };
	for (const listener of listeners) listener();
}

export function subscribeBoardPlugins(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getBoardPluginsSnapshot(): RuntimeSnapshot {
	return snapshot;
}

function readCachedDisabledBuiltins(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(DISABLED_BUILTINS_KEY) ?? "[]");
		return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

function cacheDisabledBuiltins(ids: readonly string[]): void {
	try {
		localStorage.setItem(DISABLED_BUILTINS_KEY, JSON.stringify(ids));
	} catch {
		/* storage unavailable: the next launch reconciles a frame later instead */
	}
}

/** Runs each built-in unless the user switched it off. Kanban always runs (D16). */
export function applyBuiltinBoardViews(disabled: readonly string[], builtins: readonly BuiltinBoardView[] = BUILTIN_BOARD_VIEWS): void {
	const root = getBoardRoot();
	for (const builtin of builtins) {
		const run = builtin.id === KANBAN_VIEW_ID || !disabled.includes(builtin.id);
		const fiber = builtinFibers.get(builtin.id);
		if (run && !fiber) builtinFibers.set(builtin.id, builtin.install(root));
		if (!run && fiber) {
			builtinFibers.delete(builtin.id);
			void fiber.dispose();
		}
	}
}

/** Bare `react` / `react-dom` / `cordis` imports in an extension resolve here, via the import map in index.html. */
function exposeSharedModules(): void {
	(globalThis as Record<string, unknown>).__dev3SharedModules = {
		react: React,
		"react/jsx-runtime": ReactJsxRuntime,
		"react-dom": ReactDom,
		cordis: Cordis,
	};
}

/** The extension whose plugin tree this context belongs to, if any. */
function owningExtension(ctx: Context): string | undefined {
	let fiber: Fiber | undefined = ctx.fiber;
	for (let depth = 0; fiber && depth < 64; depth++) {
		for (const [id, entry] of extensionFibers) if (entry.fiber === fiber) return id;
		const parentFiber: Fiber | undefined = fiber.parent?.fiber;
		if (parentFiber === fiber) break;
		fiber = parentFiber;
	}
	return undefined;
}

/**
 * An extension may register only the views its manifest declares, under its own
 * prefix. Anything else — a `builtin:` id, another extension's id — unloads it.
 */
function installRegistryGuard(): void {
	if (guardInstalled) return;
	guardInstalled = true;
	const registry = getBoardViewRegistry();
	registry.subscribe(() => {
		for (const view of registry.list()) {
			const owner = owningExtension(view.ctx);
			if (!owner) continue;
			const entry = extensionFibers.get(owner);
			if (entry && !entry.declared.has(view.def.id)) {
				unloadExtension(owner, { state: "failed", error: `registered an undeclared board view "${view.def.id}"` });
			}
		}
	});
}

function unloadExtension(id: string, outcome?: ExtensionLoadState): void {
	const entry = extensionFibers.get(id);
	if (entry) {
		extensionFibers.delete(id);
		void entry.fiber.dispose();
	}
	const loads = { ...snapshot.loads };
	if (outcome) loads[id] = outcome;
	else delete loads[id];
	publish({ loads });
}

function isPlugin(value: unknown): boolean {
	return typeof value === "function" || (!!value && typeof value === "object" && typeof (value as { apply?: unknown }).apply === "function");
}

async function loadExtension(ext: InstalledExtension): Promise<void> {
	const manifest = ext.manifest!;
	const declared = new Set(manifest.contributes.boardViews.map((view) => extensionViewId(manifest.id, view.id)));
	let url: string | null = null;
	try {
		const source = await api.request.getExtensionSource({ id: ext.id });
		url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
		const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
		if (!isPlugin(mod.default)) throw new Error("index.js must default-export a Cordis plugin");
		const fiber = getBoardRoot().plugin(mod.default as Parameters<Context["plugin"]>[0]);
		extensionFibers.set(ext.id, { fiber, declared });
		await fiber;
		if (!extensionFibers.has(ext.id)) return; // unloaded by the guard while starting
		if (fiber.state === FIBER_FAILED) throw new Error("its plugin failed to start (see the console)");
		publish({ loads: { ...snapshot.loads, [ext.id]: { state: "loaded" } } });
	} catch (err) {
		console.error(`[extensions] ${ext.id} failed to load:`, err);
		unloadExtension(ext.id, { state: "failed", error: err instanceof Error ? err.message : String(err) });
	} finally {
		if (url) URL.revokeObjectURL(url);
	}
}

async function reconcile(overview: ExtensionsOverview): Promise<void> {
	applyBuiltinBoardViews(overview.disabledBuiltins);
	cacheDisabledBuiltins(overview.disabledBuiltins);
	let skipOnce = false;
	try {
		skipOnce = sessionStorage.getItem(SKIP_EXTENSIONS_ONCE_KEY) === "1";
		sessionStorage.removeItem(SKIP_EXTENSIONS_ONCE_KEY);
	} catch {
		/* no storage */
	}
	const wanted = overview.enabled && !skipOnce
		? overview.extensions.filter((ext) => ext.status === "active" && ext.manifest)
		: [];
	const wantedIds = new Set(wanted.map((ext) => ext.id));
	for (const id of [...extensionFibers.keys()]) if (!wantedIds.has(id)) unloadExtension(id);
	for (const id of Object.keys(snapshot.loads)) if (!wantedIds.has(id) && !extensionFibers.has(id)) unloadExtension(id);
	if (wanted.length > 0) {
		exposeSharedModules();
		installRegistryGuard();
	}
	for (const ext of wanted) {
		if (!extensionFibers.has(ext.id) && snapshot.loads[ext.id]?.state !== "failed") await loadExtension(ext);
	}
}

/**
 * Re-reads the host's extension state and brings this window in line with it.
 * Serialized, so two quick toggles never race two loads of one extension.
 */
export function syncBoardPlugins(): Promise<ExtensionsOverview | null> {
	const run = syncChain.then(async () => {
		try {
			const overview = await api.request.listExtensions();
			publish({ overview });
			await reconcile(overview);
			return overview;
		} catch (err) {
			console.warn("[extensions] could not read extension state:", err);
			return null;
		}
	});
	syncChain = run.then(() => undefined);
	return run;
}

/** Forget a failure so the next sync retries it (after the user reinstalls or re-enables it). */
export function clearExtensionFailure(id: string): void {
	if (!snapshot.loads[id]) return;
	const loads = { ...snapshot.loads };
	delete loads[id];
	publish({ loads });
}

/** At renderer start: built-ins synchronously (from the last known toggles), then the host's real state. */
export function startBoardPlugins(): void {
	applyBuiltinBoardViews(readCachedDisabledBuiltins());
	void syncBoardPlugins();
}

/** Whether any third-party code runs in this window — the crash screens offer their escape only then. */
export function hasLoadedExtensions(): boolean {
	return extensionFibers.size > 0;
}

/**
 * The crash-screen escape: turn the kill switch off and reload. If the host cannot
 * be reached, the reload still skips extensions once, so a broken one never locks the user out.
 */
export async function restartWithExtensionsOff(): Promise<void> {
	try {
		sessionStorage.setItem(SKIP_EXTENSIONS_ONCE_KEY, "1");
	} catch {
		/* no storage */
	}
	await Promise.race([
		api.request.setExtensionsEnabled({ enabled: false }).catch(() => {}),
		new Promise((resolve) => setTimeout(resolve, 3000)),
	]);
	window.location.reload();
}

export function resetBoardPluginsForTests(): void {
	builtinFibers.clear();
	extensionFibers.clear();
	snapshot = { overview: null, loads: {} };
	listeners.clear();
	guardInstalled = false;
	syncChain = Promise.resolve();
}
