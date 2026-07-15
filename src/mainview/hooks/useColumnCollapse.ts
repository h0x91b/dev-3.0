import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { TaskStatus } from "../../shared/types";

const DEFAULT_COLLAPSED: TaskStatus[] = ["completed", "cancelled"];

function storageKey(projectId: string) {
	return `dev3-kanban-collapsed-${projectId}`;
}

function userCollapsedStorageKey(projectId: string) {
	return `dev3-kanban-user-collapsed-${projectId}`;
}

function parseStoredSet(raw: string | null): Set<string> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
			? new Set(parsed)
			: null;
	} catch {
		return null;
	}
}

interface LoadedCollapseState {
	collapsed: Set<string>;
	userCollapsed: Set<string>;
}

function loadCollapsed(projectId: string): LoadedCollapseState {
	const storedCollapsed = parseStoredSet(localStorage.getItem(storageKey(projectId)));
	const collapsed = storedCollapsed ?? new Set(DEFAULT_COLLAPSED);
	const storedUserCollapsed = parseStoredSet(localStorage.getItem(userCollapsedStorageKey(projectId)));
	if (storedUserCollapsed) return { collapsed, userCollapsed: storedUserCollapsed };

	// Older versions only persisted the complete collapsed set. Treat the built-in
	// defaults as responsive defaults so they remain reachable in the mobile carousel.
	const userCollapsed = new Set(
		[...collapsed].filter((columnId) => !DEFAULT_COLLAPSED.includes(columnId as TaskStatus)),
	);
	return { collapsed, userCollapsed };
}

function saveCollapsed(projectId: string, collapsed: Set<string>) {
	localStorage.setItem(storageKey(projectId), JSON.stringify([...collapsed]));
}

function saveUserCollapsed(projectId: string, userCollapsed: Set<string>) {
	localStorage.setItem(userCollapsedStorageKey(projectId), JSON.stringify([...userCollapsed]));
}

export interface ColumnCollapseState {
	isCollapsed: (columnId: string) => boolean;
	isUserCollapsed: (columnId: string) => boolean;
	toggle: (columnId: string) => void;
	dragExpandHandlers: (columnId: string) => {
		onDragEnter: () => void;
		onDragLeave: () => void;
		onDragEnd: () => void;
	};
}

export function useColumnCollapse(projectId: string): ColumnCollapseState {
	const [collapseState, setCollapseState] = useState<LoadedCollapseState>(() => loadCollapsed(projectId));
	const [dragExpanded, setDragExpanded] = useState<Set<string>>(new Set());
	const { collapsed, userCollapsed } = collapseState;

	const collapsedRef = useRef(collapsed);
	collapsedRef.current = collapsed;

	const dragLeaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

	// Re-load when projectId changes
	useEffect(() => {
		setCollapseState(loadCollapsed(projectId));
		setDragExpanded(new Set());
	}, [projectId]);

	// Clear all timers on unmount
	useEffect(() => {
		return () => {
			for (const t of dragLeaveTimers.current.values()) clearTimeout(t);
		};
	}, []);

	const persist = useCallback((next: Set<string>) => {
		saveCollapsed(projectId, next);
	}, [projectId]);

	const isCollapsed = useCallback((columnId: string) => {
		if (dragExpanded.has(columnId)) return false;
		return collapsed.has(columnId);
	}, [collapsed, dragExpanded]);

	const isUserCollapsed = useCallback((columnId: string) => {
		if (dragExpanded.has(columnId)) return false;
		return userCollapsed.has(columnId);
	}, [dragExpanded, userCollapsed]);

	const toggle = useCallback((columnId: string) => {
		setCollapseState((prev) => {
			const nextCollapsed = new Set(prev.collapsed);
			const nextUserCollapsed = new Set(prev.userCollapsed);
			if (nextCollapsed.has(columnId)) {
				nextCollapsed.delete(columnId);
				nextUserCollapsed.delete(columnId);
			} else {
				nextCollapsed.add(columnId);
				nextUserCollapsed.add(columnId);
			}
			persist(nextCollapsed);
			saveUserCollapsed(projectId, nextUserCollapsed);
			return { collapsed: nextCollapsed, userCollapsed: nextUserCollapsed };
		});
	}, [persist, projectId]);

	const dragExpandHandlers = useCallback((columnId: string) => ({
		onDragEnter: () => {
			// Clear any pending collapse timer
			const existing = dragLeaveTimers.current.get(columnId);
			if (existing) {
				clearTimeout(existing);
				dragLeaveTimers.current.delete(columnId);
			}

			if (!collapsedRef.current.has(columnId)) return;
			setDragExpanded((prev) => new Set(prev).add(columnId));
		},
		onDragLeave: () => {
			// Delay collapse slightly to avoid flicker when moving between children
			const timer = setTimeout(() => {
				setDragExpanded((prev) => {
					if (!prev.has(columnId)) return prev;
					const next = new Set(prev);
					next.delete(columnId);
					return next;
				});
				dragLeaveTimers.current.delete(columnId);
			}, 150);
			dragLeaveTimers.current.set(columnId, timer);
		},
		onDragEnd: () => {
			// Clear all drag expansions
			setDragExpanded(new Set());
			for (const t of dragLeaveTimers.current.values()) clearTimeout(t);
			dragLeaveTimers.current.clear();
		},
	}), []);

	return useMemo(() => ({
		isCollapsed, isUserCollapsed, toggle, dragExpandHandlers,
	}), [isCollapsed, isUserCollapsed, toggle, dragExpandHandlers]);
}
