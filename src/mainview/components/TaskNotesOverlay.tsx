import { createPortal } from "react-dom";
import type { Dispatch } from "react";
import type { Project, Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import type { AppAction } from "../state";
import { useT } from "../i18n";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";
import BottomSheet from "./BottomSheet";
import TaskNotes from "./task-info-panel/TaskNotes";

interface TaskNotesOverlayProps {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	onClose: () => void;
}

/**
 * The full note log of one task, on its own surface.
 *
 * Notes are an agent-written log (99% of the notes on disk come from `dev3 note
 * add`), so the tail is unbounded — 143 notes on the worst task. The inspector
 * body keeps a clamped preview; everything beyond it reads here. Narrow gets the
 * mandated `BottomSheet`, wide gets the same content as a centered dialog.
 */
export default function TaskNotesOverlay({ task, project, dispatch, onClose }: TaskNotesOverlayProps) {
	const t = useT();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);

	// The count belongs to whatever names this surface, so the section inside it
	// does not have to repeat the word "Notes" under a header that just said it.
	const title = `${t("notes.title")} · ${(task.notes ?? []).length}`;
	const body = (
		<TaskNotes task={task} project={project} dispatch={dispatch} variant="full" />
	);

	if (narrow) {
		return (
			<BottomSheet open onClose={onClose} title={title} testId="task-notes-sheet">
				<div className="px-4 pb-4">{body}</div>
			</BottomSheet>
		);
	}

	return createPortal(<NotesDialog task={task} title={title} onClose={onClose}>{body}</NotesDialog>, document.body);
}

function NotesDialog({ task, title, onClose, children }: { task: Task; title: string; onClose: () => void; children: React.ReactNode }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onClose);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="task-notes-title"
				tabIndex={-1}
				data-testid="task-notes-dialog"
				className="bg-overlay rounded-2xl shadow-2xl shadow-black/50 border border-edge-active w-full max-w-2xl max-h-[calc(100dvh-4rem)] mx-4 flex flex-col overflow-hidden outline-none"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="px-6 py-4 border-b border-edge flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 id="task-notes-title" className="text-fg text-lg font-semibold">{title}</h2>
						<p className="text-fg-3 text-sm mt-1 truncate">{getTaskTitle(task)}</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="flex-shrink-0 rounded p-1 text-fg-3 hover:bg-elevated hover:text-fg transition-colors"
						aria-label={t("common.close")}
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
				<div className="flex-1 overflow-auto px-6 py-4">{children}</div>
			</div>
		</div>
	);
}
