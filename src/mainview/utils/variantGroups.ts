import { ACTIVE_STATUSES, type Task } from "../../shared/types";

export const MAX_VARIANT_DOTS = 3;

function variantOrder(a: Task, b: Task): number {
	const aIndex = a.variantIndex ?? Number.POSITIVE_INFINITY;
	const bIndex = b.variantIndex ?? Number.POSITIVE_INFINITY;
	return aIndex - bIndex || a.id.localeCompare(b.id);
}

/** Return variants in their stable, human-facing variant-index order. */
export function sortVariants(variants: readonly Task[]): Task[] {
	return [...variants].sort(variantOrder);
}

/** Return only variants that still have a live agent/worktree surface. */
export function getAliveVariants(variants: readonly Task[]): Task[] {
	return sortVariants(variants.filter((variant) => ACTIVE_STATUSES.includes(variant.status)));
}

/**
 * Pick the bounded dot set for a variant group.
 *
 * The current variant is always included. Remaining slots are filled with the
 * lowest-index siblings, then the selected set is returned in stable order.
 */
export function selectVariantDots(
	variants: readonly Task[],
	currentTaskId: string,
	maxDots: number = MAX_VARIANT_DOTS,
): Task[] {
	if (variants.length <= 1 || maxDots <= 0) return [];

	const ordered = sortVariants(variants);
	const current = ordered.find((variant) => variant.id === currentTaskId);
	if (!current) return ordered.slice(0, maxDots);

	const selectedIds = new Set<string>([current.id]);
	for (const variant of ordered) {
		if (selectedIds.size >= maxDots) break;
		selectedIds.add(variant.id);
	}

	return ordered.filter((variant) => selectedIds.has(variant.id));
}

/**
 * Find the next or previous alive variant, wrapping around the ordered ring.
 * Returns null when cycling would have no meaningful effect.
 */
export function getAdjacentAliveVariant(
	variants: readonly Task[],
	currentTaskId: string,
	direction: -1 | 1,
): Task | null {
	const alive = getAliveVariants(variants);
	if (alive.length < 2) return null;

	const currentIndex = alive.findIndex((variant) => variant.id === currentTaskId);
	if (currentIndex < 0) return null;

	const nextIndex = (currentIndex + direction + alive.length) % alive.length;
	return alive[nextIndex] ?? null;
}
