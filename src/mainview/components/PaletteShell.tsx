import { Fragment, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { fuzzyRank } from "../utils/fuzzyMatch";
import { useFocusTrap } from "../utils/useFocusTrap";

/** Render text with the fuzzy-matched characters emphasized. */
export function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
	if (indices.length === 0) return <>{text}</>;
	const hit = new Set(indices);
	return (
		<>
			{text.split("").map((ch, i) =>
				hit.has(i) ? (
					<span key={i} className="text-accent font-semibold">
						{ch}
					</span>
				) : (
					<span key={i}>{ch}</span>
				),
			)}
		</>
	);
}

interface PaletteShellProps<T> {
	/** Candidate items, already scoped/ordered by the caller. */
	items: T[];
	/** Stable React key for an item. */
	getKey: (item: T) => string;
	/** Text the fuzzy matcher ranks on and the row highlights. */
	getText: (item: T) => string;
	onSelect: (item: T) => void;
	onClose: () => void;
	placeholder: string;
	ariaLabel: string;
	hint: string;
	noResults: string;
	testId?: string;
	/** Optional leading content per row (status dot, type icon, …). */
	renderItemLeft?: (item: T, index: number, query: string) => React.ReactNode;
	/** Optional trailing content per row (shortcut badge, category, …). */
	renderItemRight?: (item: T, index: number, query: string) => React.ReactNode;
	/**
	 * Optional section grouping. When set, matched rows are reordered so each
	 * group is contiguous (fuzzy order preserved *within* a group) and rendered
	 * under a non-interactive header. `groupOrder` fixes the section order; a
	 * group not listed there sorts last. Keyboard nav still walks the flat row
	 * list, skipping headers.
	 */
	getGroup?: (item: T) => string;
	groupOrder?: string[];
	groupLabel?: (group: string) => string;
}

/**
 * Shared command-palette overlay: portal, click-outside, fuzzy-filtered list,
 * keyboard navigation (↑/↓ wrap, Enter commits, Esc closes), and matched-char
 * highlighting. The Cmd+K navigation palette (GoToPaletteModal, projects+tasks)
 * and the Cmd+Shift+P action palette (CommandPaletteModal) render on top of it.
 */
export function PaletteShell<T>({
	items,
	getKey,
	getText,
	onSelect,
	onClose,
	placeholder,
	ariaLabel,
	hint,
	noResults,
	testId,
	renderItemLeft,
	renderItemRight,
	getGroup,
	groupOrder,
	groupLabel,
}: PaletteShellProps<T>) {
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const trapRef = useFocusTrap<HTMLDivElement>();

	const ranked = useMemo(() => fuzzyRank(query, items, getText), [query, items, getText]);

	// Reorder into contiguous sections (fuzzy order kept within each) so headers
	// render cleanly. Stable sort by group rank preserves the ranking inside a group.
	const rows = useMemo(() => {
		if (!getGroup || !groupOrder) return ranked;
		const rank = new Map(groupOrder.map((g, i) => [g, i]));
		return ranked
			.map((r, i) => ({ r, i, g: rank.get(getGroup(r.item)) ?? groupOrder.length }))
			.sort((a, b) => a.g - b.g || a.i - b.i)
			.map((x) => x.r);
	}, [ranked, getGroup, groupOrder]);

	// Keep the selection within bounds whenever the result set shrinks/grows.
	const selected = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);

	function commit(i: number) {
		const target = rows[i];
		if (target) onSelect(target.item);
	}

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			if (rows.length > 0) setIndex((selected + 1) % rows.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			if (rows.length > 0) setIndex((selected - 1 + rows.length) % rows.length);
		} else if (e.key === "Enter") {
			e.preventDefault();
			commit(selected);
		}
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[15vh]"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			data-testid={testId}
		>
			<div
				ref={trapRef}
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] max-h-[60vh] flex flex-col overflow-hidden outline-none"
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel}
			>
				<div className="px-3 pt-3 pb-2 border-b border-edge">
					{/* biome-ignore lint/a11y/noAutofocus: command palette is opened on demand by a shortcut */}
					<input
						autoFocus
						type="text"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setIndex(0);
						}}
						onKeyDown={handleKeyDown}
						placeholder={placeholder}
						className="w-full bg-base border border-edge rounded-lg px-3 py-2 text-fg text-sm placeholder:text-fg-muted focus:outline-none focus:border-edge-active"
						aria-label={placeholder}
					/>
				</div>

				<div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1" role="listbox">
					{rows.length === 0 ? (
						<p className="text-fg-muted text-sm px-2 py-3 text-center">{noResults}</p>
					) : (
						rows.map((r, i) => {
							const isSelected = i === selected;
							const group = getGroup?.(r.item);
							const prevGroup = i > 0 ? getGroup?.(rows[i - 1].item) : undefined;
							const showHeader = getGroup && groupLabel && group !== prevGroup;
							return (
								<Fragment key={getKey(r.item)}>
									{showHeader && (
										<div
											role="presentation"
											className="px-2.5 pt-2 pb-1 text-fg-3 text-[0.6875rem] font-semibold uppercase tracking-wide"
										>
											{groupLabel(group as string)}
										</div>
									)}
									<button
										type="button"
										role="option"
										aria-selected={isSelected}
										ref={(el) => {
											if (el && isSelected) el.scrollIntoView({ block: "nearest" });
										}}
										onMouseEnter={() => setIndex(i)}
										onClick={() => commit(i)}
										// A row with a header above it reserves top scroll-margin so
										// scrollIntoView(block:"nearest") keeps its section header visible
										// when the row is aligned to the top edge (e.g. wrapping from the
										// bottom back up to the first row).
										className={`flex items-center justify-between gap-3 w-full text-left px-2.5 py-2 rounded-lg transition-colors ${
											showHeader ? "scroll-mt-9" : ""
										} ${isSelected ? "bg-accent/15" : "hover:bg-elevated-hover"}`}
									>
										<span className="flex items-center gap-2 min-w-0 flex-1">
											{renderItemLeft?.(r.item, i, query.trim())}
											<span className="text-fg text-sm truncate min-w-0">
												<HighlightedText text={getText(r.item)} indices={r.indices} />
											</span>
										</span>
										{renderItemRight?.(r.item, i, query.trim())}
									</button>
								</Fragment>
							);
						})
					)}
				</div>

				<div className="px-4 py-2 border-t border-edge text-fg-muted text-xs">{hint}</div>
			</div>
		</div>,
		document.body,
	);
}
