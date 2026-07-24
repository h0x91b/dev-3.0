/**
 * Client-local layout state for a future native multi-pane terminal.
 *
 * A shared native host fans one PTY to several local clients (decision 158).
 * Each client keeps its own view of the shared, ordered pane set plus its own
 * focus and optional zoom. Those two overlays are client-local: reconciling or
 * mutating them here never writes back to the shared pane set and carries no
 * PTY dimension, so two clients stay independent observers of one host.
 *
 * The module is pure and import-free (no runtime side effects) — see the
 * source sentinel in the test suite and decision 164.
 */

/** A client's view of the shared, ordered pane set plus its local overlays. */
export interface ClientPaneLayout {
	/** The shared pane IDs in shared order; unique, order-significant. */
	readonly paneIds: readonly string[];
	/** The pane this client points at; null only when there are no panes. */
	readonly focusedPaneId: string | null;
	/** The pane this client has zoomed (maximized), independent of focus. */
	readonly zoomedPaneId: string | null;
}

export interface ClientPaneLayoutValidation {
	valid: boolean;
	errors: string[];
}

/** Drop non-string/empty/duplicate IDs, preserving first-occurrence order. */
function normalizePaneIds(paneIds: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of paneIds) {
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

/**
 * Pick a deterministic replacement focus when the previous focus is gone.
 * Prefer the nearest surviving pane after the old focus in the previous order,
 * then the nearest before it, then the first pane — never a removed one.
 */
function fallbackFocusedPane(
	previousPaneIds: readonly string[],
	previousFocus: string | null,
	nextPaneIds: readonly string[],
): string | null {
	if (nextPaneIds.length === 0) return null;
	const surviving = new Set(nextPaneIds);
	if (previousFocus !== null) {
		const index = previousPaneIds.indexOf(previousFocus);
		if (index >= 0) {
			for (let i = index + 1; i < previousPaneIds.length; i++) {
				if (surviving.has(previousPaneIds[i])) return previousPaneIds[i];
			}
			for (let i = index - 1; i >= 0; i--) {
				if (surviving.has(previousPaneIds[i])) return previousPaneIds[i];
			}
		}
	}
	return nextPaneIds[0];
}

/** Build a layout for a client that just observed a shared pane set. */
export function createClientPaneLayout(sharedPaneIds: readonly string[] = []): ClientPaneLayout {
	const paneIds = normalizePaneIds(sharedPaneIds);
	return {
		paneIds,
		focusedPaneId: paneIds.length > 0 ? paneIds[0] : null,
		zoomedPaneId: null,
	};
}

/**
 * Fold a fresh observation of the shared pane set into this client's layout.
 *
 * Deterministic rules: a still-present focus/zoom is kept; a removed zoom
 * target clears zoom; an invalid or missing focus falls back to a stable
 * remaining pane; an empty pane set leaves focus null. Reorders keep focus and
 * zoom. Returns the same reference when nothing changed.
 */
export function reconcileClientPaneLayout(
	layout: ClientPaneLayout,
	sharedPaneIds: readonly string[],
): ClientPaneLayout {
	const next = normalizePaneIds(sharedPaneIds);
	const surviving = new Set(next);

	const focusedPaneId =
		layout.focusedPaneId !== null && surviving.has(layout.focusedPaneId)
			? layout.focusedPaneId
			: fallbackFocusedPane(layout.paneIds, layout.focusedPaneId, next);

	const zoomedPaneId =
		layout.zoomedPaneId !== null && surviving.has(layout.zoomedPaneId)
			? layout.zoomedPaneId
			: null;

	const paneIds = sameOrder(next, layout.paneIds) ? layout.paneIds : next;
	if (
		paneIds === layout.paneIds &&
		focusedPaneId === layout.focusedPaneId &&
		zoomedPaneId === layout.zoomedPaneId
	) {
		return layout;
	}
	return { paneIds, focusedPaneId, zoomedPaneId };
}

/** Point this client at a pane. No-op if the pane is not in the shared set. */
export function focusPane(layout: ClientPaneLayout, paneId: string): ClientPaneLayout {
	if (paneId === layout.focusedPaneId || !layout.paneIds.includes(paneId)) return layout;
	return { paneIds: layout.paneIds, focusedPaneId: paneId, zoomedPaneId: layout.zoomedPaneId };
}

/** Zoom a pane (defaults to the focused pane). No-op if it is not present. */
export function zoomPane(
	layout: ClientPaneLayout,
	paneId: string | null = layout.focusedPaneId,
): ClientPaneLayout {
	if (paneId === null || paneId === layout.zoomedPaneId || !layout.paneIds.includes(paneId)) {
		return layout;
	}
	return { paneIds: layout.paneIds, focusedPaneId: layout.focusedPaneId, zoomedPaneId: paneId };
}

/** Clear zoom, leaving focus untouched. */
export function unzoomPane(layout: ClientPaneLayout): ClientPaneLayout {
	if (layout.zoomedPaneId === null) return layout;
	return { paneIds: layout.paneIds, focusedPaneId: layout.focusedPaneId, zoomedPaneId: null };
}

/** Zoom the target pane, or unzoom it when it is already zoomed. */
export function toggleZoom(
	layout: ClientPaneLayout,
	paneId: string | null = layout.focusedPaneId,
): ClientPaneLayout {
	if (paneId !== null && layout.zoomedPaneId === paneId) return unzoomPane(layout);
	return zoomPane(layout, paneId);
}

export function isPaneZoomed(layout: ClientPaneLayout): boolean {
	return layout.zoomedPaneId !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the client-local invariants (used to prove reconciliation). */
export function validateClientPaneLayout(value: unknown): ClientPaneLayoutValidation {
	const errors: string[] = [];
	if (!isRecord(value)) return { valid: false, errors: ["layout must be an object"] };

	const paneIds = value.paneIds;
	const members = new Set<string>();
	if (!Array.isArray(paneIds)) {
		errors.push("paneIds must be an array");
	} else {
		paneIds.forEach((id, index) => {
			if (typeof id !== "string" || id.length === 0) {
				errors.push(`paneIds[${index}] must be a non-empty string`);
				return;
			}
			if (members.has(id)) errors.push(`paneIds[${index}] duplicates ${id}`);
			members.add(id);
		});
	}

	const { focusedPaneId, zoomedPaneId } = value;
	if (focusedPaneId !== null && (typeof focusedPaneId !== "string" || !members.has(focusedPaneId))) {
		errors.push("focusedPaneId must be null or a member of paneIds");
	}
	if (zoomedPaneId !== null && (typeof zoomedPaneId !== "string" || !members.has(zoomedPaneId))) {
		errors.push("zoomedPaneId must be null or a member of paneIds");
	}
	if (members.size === 0 && focusedPaneId !== null) {
		errors.push("focusedPaneId must be null when there are no panes");
	}

	return { valid: errors.length === 0, errors };
}
