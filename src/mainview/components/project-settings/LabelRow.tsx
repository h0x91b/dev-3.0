import { useState, type DragEvent } from "react";
import type { Label } from "../../../shared/types";
import { useT } from "../../i18n";
import ColorSwatchPicker from "../ColorSwatchPicker";

interface LabelRowProps {
	label: Label;
	saving: boolean;
	onUpdate: (name: string, color: string) => void;
	onDelete: () => void;
	nameLabel: string;
	deleteLabel: string;
	/** Number of project tasks currently carrying this label (any status). */
	taskCount: number;
	// ---- Reorder ----
	/** Whether reorder affordances are active (disabled while any label saves). */
	reorderEnabled: boolean;
	/** This row is the current drag source (dimmed). */
	dragged: boolean;
	/** Show the accent drop line on this edge while a sibling is dragged over. */
	dropSide: "before" | "after" | null;
	isFirst: boolean;
	isLast: boolean;
	onDragStart: () => void;
	onDragOver: (event: DragEvent<HTMLDivElement>) => void;
	onDragLeave: () => void;
	onDrop: (event: DragEvent<HTMLDivElement>) => void;
	onDragEnd: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
}

export function LabelRow({
	label,
	saving,
	onUpdate,
	onDelete,
	nameLabel,
	deleteLabel,
	taskCount,
	reorderEnabled,
	dragged,
	dropSide,
	isFirst,
	isLast,
	onDragStart,
	onDragOver,
	onDragLeave,
	onDrop,
	onDragEnd,
	onMoveUp,
	onMoveDown,
}: LabelRowProps) {
	const t = useT();
	const [name, setName] = useState(label.name);
	const [color, setColor] = useState(label.color);

	function commitUpdate(newName = name, newColor = color) {
		if (newName.trim() && (newName !== label.name || newColor !== label.color)) {
			onUpdate(newName.trim(), newColor);
		}
	}

	const canDrag = reorderEnabled && !saving;

	return (
		<div
			className={`group relative flex items-center gap-1.5 p-2 pl-1.5 bg-elevated rounded-xl border border-edge hover:border-edge-active transition-[opacity,border-color] duration-150 ease-out ${dragged ? "opacity-50" : ""}`}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			{dropSide === "before" && <div className="absolute -top-1 left-3 right-3 h-0.5 bg-accent rounded-full z-10 pointer-events-none" />}
			{dropSide === "after" && <div className="absolute -bottom-1 left-3 right-3 h-0.5 bg-accent rounded-full z-10 pointer-events-none" />}
			{/* Reorder cluster — grip drags, arrows step (keyboard/touch fallback).
			    Arrows are hover/focus-revealed from `md` up; below that there is no
			    hover, so they stay visible to keep reorder reachable by touch. */}
			<div className="flex items-center gap-0.5 flex-shrink-0">
				<button
					type="button"
					draggable={canDrag}
					onDragStart={(e) => {
						if (!canDrag) return;
						e.dataTransfer.effectAllowed = "move";
						onDragStart();
					}}
					onDragEnd={onDragEnd}
					disabled={!canDrag}
					className="text-fg-muted hover:text-fg transition-colors p-1 rounded-lg hover:bg-elevated-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60 cursor-grab active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
					title={t("labels.dragToReorder")}
					aria-label={t("labels.dragToReorder")}
				>
					<span className="text-base leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F01DB}"}</span>
				</button>
				<div className="flex items-center gap-0.5 transition-opacity duration-150 ease-out md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
					<button
						type="button"
						onClick={onMoveUp}
						disabled={!reorderEnabled || saving || isFirst}
						className="text-fg-muted hover:text-fg transition-[color,background-color,opacity] duration-150 ease-out p-1 rounded-lg hover:bg-elevated-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent"
						title={t("labels.moveUp")}
						aria-label={t("labels.moveUp")}
					>
						<span className="text-sm-plus leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF062"}</span>
					</button>
					<button
						type="button"
						onClick={onMoveDown}
						disabled={!reorderEnabled || saving || isLast}
						className="text-fg-muted hover:text-fg transition-[color,background-color,opacity] duration-150 ease-out p-1 rounded-lg hover:bg-elevated-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:bg-transparent"
						title={t("labels.moveDown")}
						aria-label={t("labels.moveDown")}
					>
						<span className="text-sm-plus leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\uF063"}</span>
					</button>
				</div>
			</div>
			{/* The current-colour dot is the palette trigger */}
			<ColorSwatchPicker
				value={color}
				disabled={saving}
				label={t("labels.colorPicker")}
				onChange={(next) => {
					setColor(next);
					commitUpdate(name, next);
				}}
			/>
			{/* Name input */}
			<input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				onBlur={() => commitUpdate()}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.currentTarget.blur();
					}
				}}
				aria-label={nameLabel}
				placeholder={nameLabel}
				disabled={saving}
				className="flex-1 min-w-0 px-2 py-1 bg-transparent border border-transparent rounded-lg text-fg text-sm outline-none placeholder-fg-muted transition-colors hover:border-edge focus:border-accent/40 focus:bg-base"
			/>
			{/* Task-count badge: how many project tasks carry this label. Quiet,
			    read-only; dimmed at 0 to flag an unused label. */}
			<span
				className={`flex-shrink-0 text-xs font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-base ${
					taskCount === 0 ? "text-fg-muted" : "text-fg-3"
				}`}
				title={t.plural("labels.taskCount", taskCount)}
				aria-label={t.plural("labels.taskCount", taskCount)}
			>
				{taskCount}
			</span>
			{/* Delete */}
			<button
				type="button"
				onClick={onDelete}
				disabled={saving}
				className="grid place-items-center w-7 h-7 rounded-lg text-fg-3 hover:text-danger hover:bg-danger/10 outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-colors flex-shrink-0"
				title={deleteLabel}
				aria-label={deleteLabel}
			>
				<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	);
}
