import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { TaskStatus } from "../../shared/types";

const DEFAULT_COLLAPSED: TaskStatus[] = ["completed", "cancelled"];

function storageKey(projectId: string) {
	return `dev3-kanban-collapsed-${projectId}`;
}

function loadCollapsed(projectId: string): Set<string> {
	try {
		const raw = localStorage.getItem(storageKey(projectId));
		if (raw) return new Set(JSON.parse(raw));
	} catch {}
	return new Set(DEFAULT_COLLAPSED);
}

function saveCollapsed(projectId: string, collapsed: Set<string>) {
	localStorage.setItem(storageKey(projectId), JSON.stringify([...collapsed]));
}

export interface ColumnCollapseState {
	isCollapsed: (columnId: string) => boolean;
	toggle: (columnId: string) => void;
	dragExpandHandlers: (columnId: string) => {
		onDragEnter: () => void;
		onDragLeave: () => void;
		onDragEnd: () => void;
	};
}

export function useColumnCollapse(projectId: string): ColumnCollapseState {
	const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(projectId));
	const [dragExpanded, setDragExpanded] = useState<Set<string>>(new Set());

	const collapsedRef = useRef(collapsed);
	collapsedRef.current = collapsed;

	const dragLeaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

	// Re-load when projectId changes
	useEffect(() => {
		setCollapsed(loadCollapsed(projectId));
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

	const toggle = useCallback((columnId: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(columnId)) {
				next.delete(columnId);
			} else {
				next.add(columnId);
			}
			persist(next);
			return next;
		});
	}, [persist]);

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
		isCollapsed, toggle, dragExpandHandlers,
	}), [isCollapsed, toggle, dragExpandHandlers]);
}
