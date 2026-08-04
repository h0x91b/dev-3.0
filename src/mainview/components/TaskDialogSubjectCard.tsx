import type { Label, TaskPriority } from "../../shared/types";
import LabelChip from "./LabelChip";
import PriorityBadge from "./PriorityBadge";

export interface TaskDialogSubjectCardProps {
	/** Prominent line — normally the task title. */
	title: string;
	/** Secondary line — normally the task overview. */
	body?: string;
	/** Per-project task id, variant suffix included (e.g. `"1159"`, `"1159-1"`). */
	seqLabel?: string;
	/** Owning project's display name. */
	projectName?: string;
	/** Task importance band, shown as a static `P{n}` badge. */
	priority?: TaskPriority;
	/** Resolved task labels; read-only chips under the body. */
	labels?: Label[];
	/**
	 * `accent` tints the whole card (the dialog is *about* this task);
	 * `neutral` steps back when the dialog's own content already carries accent.
	 */
	tone?: "accent" | "neutral";
	/** Makes the title a button — e.g. to open the task. */
	onTitleClick?: () => void;
}

/**
 * The read-only "which task is this about" card shared by every dialog that acts
 * on one task — the agent completion confirm, the merge prompt, and the
 * agent launch request. The identity row (seq · project · priority) matters most
 * when the dialog fires while the user is looking at a different board.
 */
function TaskDialogSubjectCard({
	title,
	body,
	seqLabel,
	projectName,
	priority,
	labels,
	tone = "accent",
	onTitleClick,
}: TaskDialogSubjectCardProps) {
	const neutral = tone === "neutral";
	const hasIdentityRow = Boolean(seqLabel || projectName || priority);

	return (
		<div className={`rounded-xl border px-4 py-3 ${neutral ? "bg-elevated/70 border-edge" : "bg-accent/10 border-accent/30"}`}>
			{hasIdentityRow && (
				<div className="flex items-center flex-wrap gap-x-2 gap-y-1 mb-2 text-fg-3 text-xs">
					{seqLabel && <span className="font-mono text-fg-2">{`#${seqLabel}`}</span>}
					{projectName && (
						<>
							{seqLabel && <span aria-hidden>·</span>}
							<span className="truncate max-w-[12rem]">{projectName}</span>
						</>
					)}
					{priority && <PriorityBadge priority={priority} size="sm" className="ml-auto" />}
				</div>
			)}
			<div className="flex items-start gap-2">
				<span
					className={`${neutral ? "text-fg-3" : "text-accent"} text-base-lg leading-snug`}
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0AE2}"}
				</span>
				{/* `text-base` is unusable here: the project defines a `base` color
				    token, so Tailwind also emits text-base as a COLOR utility that
				    overrides text-accent. Use an arbitrary font-size instead. */}
				{onTitleClick ? (
					<button
						type="button"
						onClick={onTitleClick}
						aria-label={title}
						className={`${neutral ? "text-fg" : "text-accent"} min-w-0 rounded-sm text-left text-base-lg font-semibold leading-snug underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60`}
					>
						{title}
					</button>
				) : (
					<div className={`${neutral ? "text-fg" : "text-accent"} text-base-lg font-semibold leading-snug`}>
						{title}
					</div>
				)}
			</div>
			{body && <div className="text-fg-2 text-sm leading-relaxed mt-1.5 whitespace-pre-line">{body}</div>}
			{labels && labels.length > 0 && (
				<div className="flex items-center flex-wrap gap-1 mt-2">
					{labels.map((label) => (
						<LabelChip key={label.id} label={label} size="sm" />
					))}
				</div>
			)}
		</div>
	);
}

export default TaskDialogSubjectCard;
