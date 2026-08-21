import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../hooks/useEscapeKey";
import type { Space } from "../../shared/types";
import { useT } from "../i18n";
import { MASK_CLASS } from "../sensitive-projects";

interface SpacePickerProps {
	/** Active spaces in display order (from useSpaces — the parent owns state). */
	spaces: Space[];
	/** Currently-selected space ids (controlled by the parent). */
	selectedIds: string[];
	/** Toggle membership. The parent owns persistence. */
	onToggle: (spaceId: string) => void;
	/** Create a space with the typed name (the parent decides the first member).
	 *  Omitted when creation is impossible, e.g. no project exists yet. */
	onCreateNew?: (name: string) => void;
	anchorEl: HTMLElement;
	onClose: () => void;
}

function fuzzyMatch(text: string, query: string): boolean {
	if (!query) return true;
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	let qi = 0;
	for (let i = 0; i < lower.length && qi < q.length; i++) {
		if (lower[i] === q[qi]) qi++;
	}
	return qi === q.length;
}

function SpacePicker({ spaces, selectedIds, onToggle, onCreateNew, anchorEl, onClose }: SpacePickerProps) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [pos, setPos] = useState({ top: 0, left: 0 });
	const [visible, setVisible] = useState(false);
	const pickerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const filtered = query ? spaces.filter((s) => fuzzyMatch(s.name, query)) : spaces;

	const showCreate =
		!!onCreateNew &&
		query.trim().length > 0 &&
		!spaces.some((s) => s.name.toLowerCase() === query.trim().toLowerCase());

	// Position the picker relative to anchor, clamped to viewport
	useLayoutEffect(() => {
		if (!pickerRef.current) return;
		const anchor = anchorEl.getBoundingClientRect();
		const picker = pickerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pad = 8;

		let top = anchor.bottom + 4;
		let left = anchor.left;

		if (top + picker.height > vh - pad) top = anchor.top - picker.height - 4;
		if (left + picker.width > vw - pad) left = vw - picker.width - pad;
		if (left < pad) left = pad;
		if (top < pad) top = pad;

		setPos({ top, left });
		setVisible(true);
		inputRef.current?.focus();
	}, [anchorEl]);

	useEscapeKey(onClose);
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (
				pickerRef.current &&
				!pickerRef.current.contains(e.target as Node) &&
				!anchorEl.contains(e.target as Node)
			) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [anchorEl, onClose]);

	function createFromQuery() {
		const name = query.trim();
		if (!name || !onCreateNew) return;
		onCreateNew(name);
		setQuery("");
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter") {
			e.preventDefault();
			if (filtered.length > 0 && !showCreate) onToggle(filtered[0].id);
			else if (showCreate) createFromQuery();
		}
	}

	return createPortal(
		<div
			ref={pickerRef}
			data-testid="space-picker"
			className="fixed z-50 bg-overlay rounded-xl shadow-2xl shadow-black/40 border border-edge-active overflow-hidden"
			style={{ top: pos.top, left: pos.left, width: 240, visibility: visible ? "visible" : "hidden" }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="p-2 border-b border-edge/50">
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={t("spaces.searchPlaceholder")}
					className="w-full bg-elevated border border-edge rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
				/>
			</div>

			<div className="max-h-48 overflow-y-auto p-1">
				{filtered.length === 0 && !showCreate && (
					<div className="px-3 py-4 text-xs text-fg-muted text-center">{t("spaces.noSpaces")}</div>
				)}
				{filtered.map((space) => {
					const isOn = selectedIds.includes(space.id);
					return (
						<button
							key={space.id}
							type="button"
							onClick={() => onToggle(space.id)}
							className="w-full text-left px-2 py-1.5 rounded-lg flex items-center gap-2.5 hover:bg-elevated-hover transition-colors"
							data-testid={`space-picker-row-${space.id}`}
							aria-pressed={isOn}
						>
							{/* A box on the left, filled or empty, says "several of these
							    can be on" before anything is clicked. A checkmark that
							    only exists when selected leaves an unselected row looking
							    like a one-shot menu item. */}
							<span
								aria-hidden="true"
								className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
									isOn ? "bg-accent border-accent text-white" : "border-edge-active text-transparent"
								}`}
							>
								<svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
								</svg>
							</span>
							<span className={`text-xs text-fg flex-1 truncate ${space.sensitive ? MASK_CLASS : ""}`}>{space.name}</span>
						</button>
					);
				})}

				{showCreate && (
					<button
						type="button"
						onClick={createFromQuery}
						className="w-full text-left px-2 py-1.5 mt-1 rounded-lg flex items-center gap-2.5 hover:bg-elevated-hover transition-colors border-t border-edge/40"
						data-testid="space-picker-create"
					>
						<svg
							className="w-3.5 h-3.5 flex-shrink-0 text-accent"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2.5}
						>
							<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
						</svg>
						<span className="text-xs text-accent truncate">{t("spaces.createSpace", { name: query.trim() })}</span>
					</button>
				)}
			</div>
		</div>,
		document.body,
	);
}

export default SpacePicker;
