import { createContext, Fragment, useContext, useMemo, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { useT } from "../i18n";
import { activateTaskPrRef } from "../task-ref-open";
import { findRefsInText, formatRef, refUri, type TaskPrRef } from "../../shared/task-refs";
import type { TaskPRBadgeInfo } from "../../shared/types";
import { useTaskPrRefPreview } from "../task-ref-preview";
import { TaskRefHoverCard } from "./TaskRefPreviewCard";
import TaskPrStatusPopover from "./TaskPrStatusPopover";

/**
 * A reference reads as the board's own chip (the card's `#seq` ink on an accent
 * tint), so it is visibly a task or PR and not just a coloured word. Inline, not
 * inline-flex: the chip has to sit on the text's baseline and wrap with it. A PR
 * also gets the card's PR glyph, painted by `.task-ref-pr` so copying skips it.
 */
const REF_CHIP_CLASS = "inline cursor-pointer rounded-[0.3125rem] border-0 bg-accent/10 px-1 py-px align-baseline font-mono font-semibold text-accent [box-decoration-break:clone] transition-[color,background-color] duration-150 ease-out hover:bg-accent/20 hover:text-accent-emphasis focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";

interface TaskRefScope {
	/** Project a bare reference belongs to — the project of the surrounding text. */
	projectId?: string;
	taskId?: string;
}

/**
 * Where a bare reference resolves when the renderer cannot pass it down — inside
 * markdown, whose link component knows nothing about the task it renders for.
 */
export const TaskRefScopeContext = createContext<TaskRefScope>({});

interface TaskRefLinkProps {
	taskRef: TaskPrRef;
	contextProjectId?: string;
	taskId?: string;
	/** A markdown link's own label; defaults to the token. */
	children?: ReactNode;
	/** False inside a preview card: a nested card would close its parent on the way in. */
	preview?: boolean;
}

/**
 * One `<seq:N>` / `<pr:N>` reference as an inline link. The label drops the angle
 * brackets (`seq:115`, `pr:2187`) so it reads as a link, not markup, while staying
 * the same token agents write. A task opens in the app, a PR on GitHub; hovering
 * previews either one.
 */
export function TaskRefLink({ taskRef, contextProjectId, taskId, children, preview = true }: TaskRefLinkProps) {
	const t = useT();
	const scope = useContext(TaskRefScopeContext);
	const projectId = contextProjectId ?? scope.projectId;
	const errorTaskId = taskId ?? scope.taskId;
	const token = formatRef(taskRef);
	const uri = refUri(taskRef);
	const onClick = (event: MouseEvent) => {
		// Refs sit inside clickable rows and cards; the link wins the click.
		event.preventDefault();
		event.stopPropagation();
		void activateTaskPrRef(uri, { t, contextProjectId: projectId, taskId: errorTaskId });
	};
	const link = (
		<button
			type="button"
			onClick={onClick}
			className={`${REF_CHIP_CLASS} ${taskRef.kind === "pr" ? "task-ref-pr" : ""}`}
			aria-label={t(taskRef.kind === "task" ? "taskRef.openTask" : "taskRef.openPr", { ref: token })}
			data-task-ref={uri}
		>
			{children ?? uri}
		</button>
	);
	if (!preview) return link;
	return taskRef.kind === "task"
		? <TaskRefHoverCard refUri={uri} contextProjectId={projectId}>{link}</TaskRefHoverCard>
		: <PrRefPopover number={taskRef.number} refUri={uri} contextProjectId={projectId}>{link}</PrRefPopover>;
}

/** A `<pr:N>` gets the same status popover as a card's PR badge, loaded on first open. */
function PrRefPopover({ number, refUri: uri, contextProjectId, children }: { number: number; refUri: string; contextProjectId?: string; children: ReactElement }) {
	const { state, load, refresh } = useTaskPrRefPreview(uri, contextProjectId);
	const preview = state.status === "ready" && state.preview?.kind === "pr" ? state.preview : null;
	const prInfo: TaskPRBadgeInfo = preview?.badge ?? { number, url: preview?.target.url ?? "" };
	return (
		<TaskPrStatusPopover
			prInfo={prInfo}
			onOpen={load}
			onRefresh={async () => {
				const fresh = await refresh();
				return fresh?.kind === "pr" && fresh.badge != null;
			}}
		>
			{children}
		</TaskPrStatusPopover>
	);
}

/** Split plain text into strings and reference links. Pure, so it is unit-testable. */
export function splitTaskRefs(text: string): Array<string | { ref: TaskPrRef; key: number }> {
	const parts: Array<string | { ref: TaskPrRef; key: number }> = [];
	let cursor = 0;
	for (const match of findRefsInText(text)) {
		if (match.start > cursor) parts.push(text.slice(cursor, match.start));
		parts.push({ ref: match.ref, key: match.start });
		cursor = match.end;
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts;
}

interface TaskRefTextProps {
	text: string;
	contextProjectId?: string;
	taskId?: string;
	preview?: boolean;
}

/**
 * Agent-written plain text with every `<seq:N>` / `<pr:N>` turned into a link.
 * Renders inline fragments only, so it drops into any existing `whitespace-pre-wrap`
 * container without changing its layout.
 */
export function TaskRefText({ text, contextProjectId, taskId, preview }: TaskRefTextProps): ReactNode {
	const parts = useMemo(() => splitTaskRefs(text), [text]);
	if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
	return parts.map((part, i) =>
		typeof part === "string"
			? <Fragment key={`t${i}`}>{part}</Fragment>
			: <TaskRefLink key={`r${part.key}`} taskRef={part.ref} contextProjectId={contextProjectId} taskId={taskId} preview={preview} />,
	);
}
