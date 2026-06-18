import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "../../shared/types";
import { useT } from "../i18n";
import { fuzzyRank } from "../utils/fuzzyMatch";

interface ProjectQuickSwitchModalProps {
	/** Non-deleted projects, in board order. */
	projects: Project[];
	onSelect: (projectId: string) => void;
	onClose: () => void;
}

/** Render a project name with matched characters emphasized. */
function HighlightedName({ name, indices }: { name: string; indices: number[] }) {
	if (indices.length === 0) return <>{name}</>;
	const hit = new Set(indices);
	return (
		<>
			{name.split("").map((ch, i) =>
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

/**
 * VSCode-style Cmd/Ctrl+K project quick-switch palette. Type to fuzzy-filter
 * projects by name; Enter jumps to the highlighted match (the top one by default).
 */
function ProjectQuickSwitchModal({ projects, onSelect, onClose }: ProjectQuickSwitchModalProps) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);

	const results = useMemo(() => fuzzyRank(query, projects, (p) => p.name), [query, projects]);

	// Keep the selection within bounds whenever the result set shrinks/grows.
	const selected = results.length === 0 ? -1 : Math.min(index, results.length - 1);

	function commit(i: number) {
		const target = results[i];
		if (target) onSelect(target.item.id);
	}

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			if (results.length > 0) setIndex((selected + 1) % results.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			if (results.length > 0) setIndex((selected - 1 + results.length) % results.length);
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
			data-testid="project-quick-switch"
		>
			<div
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] max-h-[60vh] flex flex-col overflow-hidden"
				role="dialog"
				aria-label={t("projectSwitch.title")}
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
						placeholder={t("projectSwitch.placeholder")}
						className="w-full bg-base border border-edge rounded-lg px-3 py-2 text-fg text-sm placeholder:text-fg-muted focus:outline-none focus:border-edge-active"
						aria-label={t("projectSwitch.placeholder")}
					/>
				</div>

				<div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1" role="listbox">
					{results.length === 0 ? (
						<p className="text-fg-muted text-sm px-2 py-3 text-center">{t("projectSwitch.noResults")}</p>
					) : (
						results.map((r, i) => {
							const isSelected = i === selected;
							const shortcutNum = i < 9 ? i + 1 : null;
							return (
								<button
									key={r.item.id}
									type="button"
									role="option"
									aria-selected={isSelected}
									ref={(el) => {
										if (el && isSelected) el.scrollIntoView({ block: "nearest" });
									}}
									onMouseEnter={() => setIndex(i)}
									onClick={() => commit(i)}
									className={`flex items-center justify-between gap-3 w-full text-left px-2.5 py-2 rounded-lg transition-colors ${
										isSelected ? "bg-accent/15" : "hover:bg-elevated-hover"
									}`}
								>
									<span className="text-fg text-sm truncate min-w-0">
										<HighlightedName name={r.item.name} indices={r.indices} />
									</span>
									{shortcutNum !== null && query.trim().length === 0 && (
										<span className="text-fg-3 text-xs flex-shrink-0">⌘{shortcutNum}</span>
									)}
								</button>
							);
						})
					)}
				</div>

				<div className="px-4 py-2 border-t border-edge text-fg-muted text-xs">{t("projectSwitch.hint")}</div>
			</div>
		</div>,
		document.body,
	);
}

export default ProjectQuickSwitchModal;
