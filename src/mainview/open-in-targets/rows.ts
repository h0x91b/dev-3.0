import { useMemo, useSyncExternalStore } from "react";
import { DEFAULT_EXTERNAL_APPS, type ExternalApp } from "../../shared/types";
import { useAvailableApps } from "../hooks/useAvailableApps";
import type { SlotEntry } from "../plugins/slot-registry";
import { api } from "../rpc";
import { getOpenInTargetRegistry, type OpenInCategory, type OpenInTarget } from "./registry";

/** Fallback glyph for an app without a target icon (generic "open in new"). */
export const OPEN_IN_ICON_FALLBACK = "\u{F0645}";

/** One "Open in…" row: an app bun detected, drawn by its target. */
export interface OpenInRow {
	appId: string;
	name: string;
	/** A user-added app (from Settings) rather than one of the built-in defaults. */
	custom: boolean;
	/** The target's glyph, or undefined when it has none. */
	icon: string | undefined;
	brandColor: string;
	category: OpenInCategory | "custom";
}

const DEFAULT_APP_IDS = new Set(DEFAULT_EXTERNAL_APPS.map((app) => app.id));
const CATEGORIES: readonly string[] = ["files", "editor", "terminal"];

/** Deterministic palette for custom apps that have no known brand color. */
const CUSTOM_BRAND_PALETTE = ["#14b8a6", "#6366f1", "#ef4444", "#0ea5e9", "#d946ef", "#f43f5e", "#84cc16", "#a855f7"];

function hashedBrandColor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	return CUSTOM_BRAND_PALETTE[hash % CUSTOM_BRAND_PALETTE.length];
}

const reportedFailures = new Set<string>();

/** Once per target: every open menu re-derives its rows on each render. */
function reportOnce(id: string, err: unknown): void {
	if (reportedFailures.has(id)) return;
	reportedFailures.add(id);
	console.error(`[slots] open-in target ${id} is malformed; ignoring it:`, err);
}

export function resetOpenInTargetFailuresForTests(): void {
	reportedFailures.clear();
}

interface Presentation {
	appId: string;
	icon?: string;
	brandColor?: string;
	category?: OpenInCategory;
}

/** A target's fields read once and type-checked, so a malformed one cannot throw inside a menu render. */
function readTarget(entry: SlotEntry<OpenInTarget>): Presentation | null {
	const def = entry.def;
	try {
		const { appId, icon, brandColor, category } = def;
		if (typeof appId !== "string") throw new Error("appId is not a string");
		if (icon !== undefined && typeof icon !== "string") throw new Error("icon is not a string");
		if (brandColor !== undefined && typeof brandColor !== "string") throw new Error("brandColor is not a string");
		if (category !== undefined && !CATEGORIES.includes(category)) throw new Error("unknown category");
		return { appId, icon, brandColor, category };
	} catch (err) {
		reportOnce(String(def.id), err);
		return null;
	}
}

/**
 * The rows, in bun's detection order. A default app shows only while a target draws it, so unloading a
 * target takes its row away; a user-added app falls back to a plain row. A target whose app bun did not
 * detect draws nothing: the slot can restyle an app, never add one.
 */
export function placeOpenInRows(apps: readonly ExternalApp[], entries: readonly SlotEntry<OpenInTarget>[]): OpenInRow[] {
	const byApp = new Map<string, Presentation>();
	for (const entry of entries) {
		const target = readTarget(entry);
		if (target && !byApp.has(target.appId)) byApp.set(target.appId, target);
	}
	const rows: OpenInRow[] = [];
	for (const app of apps) {
		const custom = !DEFAULT_APP_IDS.has(app.id);
		const target = byApp.get(app.id);
		if (!custom && !target) continue;
		rows.push({
			appId: app.id,
			name: app.name,
			custom,
			icon: target?.icon,
			brandColor: target?.brandColor ?? hashedBrandColor(app.id),
			category: custom ? "custom" : target?.category ?? "editor",
		});
	}
	return rows;
}

/** The "Open in…" rows for an open menu or launcher. Mount it only while the surface is open. */
export function useOpenInRows(): OpenInRow[] {
	const apps = useAvailableApps();
	const registry = getOpenInTargetRegistry();
	const entries = useSyncExternalStore(registry.subscribe, registry.list);
	return useMemo(() => placeOpenInRows(apps, entries), [apps, entries]);
}

/** Opens `path` in the row's app. Bun resolves the id and refuses anything it does not know. */
export function openInRow(row: Pick<OpenInRow, "appId">, path: string): Promise<void> {
	return api.request.openInApp({ appId: row.appId, path });
}
