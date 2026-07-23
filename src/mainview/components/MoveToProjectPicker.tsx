import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import BottomSheet from "./BottomSheet";

interface MoveToProjectPickerProps {
	/** The task's current project — always excluded from the destination list. */
	currentProjectId: string;
	/** Anchor for the desktop popover (the "Move to project…" trigger button). */
	anchorEl: HTMLElement;
	/** Fired with the chosen destination; the parent performs the actual move. */
	onSelect: (project: Project) => void;
	onClose: () => void;
}

/** Below this width the picker is a thumb-friendly bottom sheet instead of a popover. */
const MOBILE_MAX_WIDTH = 768;
const POPOVER_WIDTH = 260;

/**
 * Searchable destination-project picker for "Move to project…". Desktop renders
 * an anchored popover (portaled + viewport-clamped, like LabelPicker); narrow
 * viewports render a bottom sheet (the app's mandated mobile surface — the fixed
 * detail-modal width would clip an in-modal popover on a phone). The current
 * project and deleted projects are never listed. Selection is delegated to the
 * parent via `onSelect`; this component owns only discovery + search + layout.
 */
export default function MoveToProjectPicker({ currentProjectId, anchorEl, onSelect, onClose }: MoveToProjectPickerProps) {
	const t = useT();
	const narrow = useNarrowViewport(MOBILE_MAX_WIDTH);
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [query, setQuery] = useState("");
	const popoverRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [positioned, setPositioned] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const all = await api.request.getProjects();
				if (!cancelled) setProjects(all);
			} catch {
				if (!cancelled) setProjects([]);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const destinations = useMemo(() => {
		const list = (projects ?? []).filter((p) => p.id !== currentProjectId && !p.deleted);
		const q = query.trim().toLowerCase();
		return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
	}, [projects, currentProjectId, query]);

	const loading = projects === null;

	// Position the desktop popover relative to the anchor, clamped to the viewport,
	// flipping above when it would overflow the bottom (the trigger sits in the
	// modal footer). Re-runs as content height settles after the async load.
	useLayoutEffect(() => {
		if (narrow || !popoverRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const rect = popoverRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;
		let top = anchor.bottom + 4;
		let left = anchor.left;
		if (top + rect.height > vh - pad) top = anchor.top - rect.height - 4;
		if (left + rect.width > vw - pad) left = vw - rect.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;
		setPos({ top, left });
		setPositioned(true);
	}, [anchorEl, narrow, loading, destinations.length]);

	// Auto-focus the search field once mounted (both surfaces).
	useEffect(() => {
		const id = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(id);
	}, [narrow]);

	// Desktop: dismiss on click outside the popover and its anchor.
	useEffect(() => {
		if (narrow) return;
		function handleClick(e: MouseEvent) {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [narrow, anchorEl, onClose]);

	const searchInput = (
		<input
			ref={inputRef}
			type="text"
			value={query}
			onChange={(e) => setQuery(e.target.value)}
			placeholder={t("task.moveToProjectSearch")}
			className="w-full bg-elevated border border-edge rounded-lg px-2.5 py-1.5 text-sm text-fg placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
			aria-label={t("task.moveToProjectSearch")}
		/>
	);

	const list = (
		<div className="max-h-60 overflow-y-auto py-1" data-testid="move-to-project-list">
			{loading ? (
				<div className="px-3 py-4 text-center text-xs text-fg-muted">…</div>
			) : destinations.length === 0 ? (
				<div className="px-3 py-4 text-center text-xs text-fg-muted">{t("task.moveToProjectEmpty")}</div>
			) : (
				destinations.map((p) => (
					<button
						key={p.id}
						type="button"
						onClick={() => onSelect(p)}
						className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-elevated-hover"
					>
						<span className="truncate text-sm text-fg">{p.name}</span>
					</button>
				))
			)}
		</div>
	);

	if (narrow) {
		return (
			<BottomSheet open onClose={onClose} title={t("task.moveToProjectTitle")} testId="move-to-project-sheet">
				<div className="pb-1">{searchInput}</div>
				{list}
			</BottomSheet>
		);
	}

	return createPortal(
		<div
			ref={popoverRef}
			role="dialog"
			aria-label={t("task.moveToProjectTitle")}
			data-testid="move-to-project-popover"
			className="fixed z-[60] overflow-hidden rounded-xl border border-edge-active bg-overlay shadow-2xl shadow-black/40"
			style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH, visibility: positioned ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="border-b border-edge/50 p-2">{searchInput}</div>
			{list}
		</div>,
		document.body,
	);
}
