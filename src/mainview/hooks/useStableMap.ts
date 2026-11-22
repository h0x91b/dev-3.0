import { useMemo, useRef } from "react";
import type { Task } from "../../shared/types";

/**
 * `next` with every value that `same` deems unchanged swapped for the previous render's
 * object, so a memoized consumer of one entry skips renders caused by another entry.
 */
export function useStableMap<K, V>(next: Map<K, V>, same: (prev: V, next: V) => boolean): Map<K, V> {
	const prevRef = useRef(new Map<K, V>());
	return useMemo(() => {
		const prev = prevRef.current;
		const out = new Map<K, V>();
		for (const [key, value] of next) {
			const old = prev.get(key);
			out.set(key, old !== undefined && same(old, value) ? old : value);
		}
		prevRef.current = out;
		return out;
	}, [next, same]);
}

/** Same tasks, same order, same objects. */
export function sameMembers(prev: readonly Task[], next: readonly Task[]): boolean {
	return prev.length === next.length && prev.every((task, i) => task === next[i]);
}

/** Equal as plain JSON data. Only for values that are plain data. */
export function sameJson<V>(prev: V, next: V): boolean {
	return JSON.stringify(prev) === JSON.stringify(next);
}

/** Variant groups by `groupId`; a group keeps its array identity until one of its members changes. */
export function useVariantGroups(tasks: readonly Task[]): Map<string, Task[]> {
	const groups = useMemo(() => {
		const map = new Map<string, Task[]>();
		for (const task of tasks) {
			if (!task.groupId) continue;
			const group = map.get(task.groupId);
			if (group) group.push(task);
			else map.set(task.groupId, [task]);
		}
		return map;
	}, [tasks]);
	return useStableMap(groups, sameMembers);
}
