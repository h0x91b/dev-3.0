import { createContext, Fragment, useContext, useMemo, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { useT } from "../i18n";
import { isElectrobun } from "../rpc";
import { activateTaskPrRef } from "../task-ref-open";
import { findRefsInText, formatRef, refUri, type TaskPrRef } from "../../shared/task-refs";
import type { TaskPRBadgeInfo } from "../../shared/types";
import { useTaskPrRefPreview } from "../task-ref-preview";
import { TaskRefHoverCard } from "./TaskRefPreviewCard";
import TaskPrStatusPopover from "./TaskPrStatusPopover";
import Tooltip from "./Tooltip";
import { findPathCandidates } from "../../shared/path-candidates";
import { findPathRefsInText, pathRefUri } from "../../shared/path-refs";
import { activateTerminalPath } from "../terminal-path-open";
import { pathLinkLabel, useResolvedTextPath } from "../text-path-links";

/**
 * A reference reads as the board's own chip (the card's `#seq` ink on an accent
 * tint), so it is visibly a task or PR and not just a coloured word. Inline, not
 * inline-flex: the chip has to sit on the text's baseline and wrap with it. A PR
 * also gets the card's PR glyph, painted by `.task-ref-pr` so copying skips it.
 */
const REF_CHIP_CLASS = "inline cursor-pointer select-text rounded-[0.3125rem] border-0 bg-accent/10 px-1 py-px align-baseline font-mono font-semibold text-accent [box-decoration-break:clone] transition-[color,background-color] duration-150 ease-out hover:bg-accent/20 hover:text-accent-emphasis focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";

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

interface PathLinkProps {
	/** The path as resolved on disk, `:line` suffix stripped. */
	path: string;
	line?: number;
	contextProjectId?: string;
	taskId?: string;
	/** What the text shows while the path resolves, and for good when it does not. */
	children: ReactNode;
	/** The chip label; defaults to the children. */
	label?: string;
}

/**
 * A file path written in task text. It stays plain text until the backend finds
 * the file, then becomes a chip that opens the in-app preview; the full path
 * shows on hover.
 */
export function PathLink({ path, line, contextProjectId, taskId, children, label }: PathLinkProps) {
	const t = useT();
	const scope = useContext(TaskRefScopeContext);
	const projectId = contextProjectId ?? scope.projectId;
	const ownerTaskId = taskId ?? scope.taskId;
	const resolved = useResolvedTextPath(path, projectId, ownerTaskId);
	// The browser cannot open a host folder, so there a folder stays plain text.
	if (!resolved || (resolved.kind === "directory" && !isElectrobun)) return <>{children}</>;
	const fullPath = line ? `${resolved.path}:${line}` : resolved.path;
	const onClick = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		void activateTerminalPath(resolved, t, line, ownerTaskId);
	};
	return (
		<Tooltip content={<span className="streamer-private break-all font-mono">{fullPath}</span>} detail={t(resolved.kind === "directory" ? "pathLink.openFolder" : "pathLink.openFile")} wide>
			<button
				type="button"
				onClick={onClick}
				className={PATH_CHIP_CLASS}
				aria-label={t(resolved.kind === "directory" ? "pathLink.openFolderAria" : "pathLink.openFileAria", { path: fullPath })}
				data-path-link={resolved.path}
			>
				{label === undefined ? children : (
					<>
						{/* The short label shows; the written path is what a copy of the text carries. */}
						<span className="sr-only">{children}</span>
						<span aria-hidden="true" className="select-none">{label}</span>
					</>
				)}
			</button>
		</Tooltip>
	);
}

const PATH_CHIP_CLASS = REF_CHIP_CLASS.replace("font-semibold", "font-medium");

type TextPart =
	| string
	| { kind: "ref"; ref: TaskPrRef; key: number }
	| { kind: "path"; raw: string; path: string; line?: number; key: number; label?: string };

/** Split plain text into strings, reference links, path tokens and path candidates. Pure, so it is unit-testable. */
export function splitTaskText(text: string, paths = true): TextPart[] {
	const parts: TextPart[] = [];
	const pushText = (chunk: string, offset: number) => {
		if (!chunk) return;
		if (!paths) {
			parts.push(chunk);
			return;
		}
		let cursor = 0;
		for (const candidate of findPathCandidates(chunk)) {
			if (candidate.start > cursor) parts.push(chunk.slice(cursor, candidate.start));
			parts.push({ kind: "path", raw: candidate.raw, path: candidate.cleanPath, line: candidate.line, key: offset + candidate.start });
			cursor = candidate.end + 1;
		}
		if (cursor < chunk.length) parts.push(chunk.slice(cursor));
	};
	const tokens: Array<{ start: number; end: number; part: TextPart }> = findRefsInText(text).map((match) => ({
		start: match.start,
		end: match.end,
		part: { kind: "ref", ref: match.ref, key: match.start },
	}));
	if (paths) {
		for (const match of findPathRefsInText(text)) {
			const { line, ...file } = match.ref;
			tokens.push({
				start: match.start,
				end: match.end,
				part: { kind: "path", raw: match.raw, path: pathRefUri(file), line, key: match.start, label: `${file.path}${line ? `:${line}` : ""}` },
			});
		}
		tokens.sort((a, b) => a.start - b.start);
	}
	let cursor = 0;
	for (const token of tokens) {
		if (token.start < cursor) continue;
		pushText(text.slice(cursor, token.start), cursor);
		parts.push(token.part);
		cursor = token.end;
	}
	pushText(text.slice(cursor), cursor);
	return parts;
}

interface TaskRefTextProps {
	text: string;
	contextProjectId?: string;
	taskId?: string;
	preview?: boolean;
	/** False in dense lists (table cells, sidebar rows), where every row would resolve its own paths. */
	pathLinks?: boolean;
}

/**
 * Agent-written plain text with every `<seq:N>` / `<pr:N>` and every existing file
 * path turned into a link. Renders inline fragments only, so it drops into any
 * existing `whitespace-pre-wrap` container without changing its layout.
 */
export function TaskRefText({ text, contextProjectId, taskId, preview, pathLinks = true }: TaskRefTextProps): ReactNode {
	const parts = useMemo(() => splitTaskText(text, pathLinks), [text, pathLinks]);
	if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
	return parts.map((part, i) => {
		if (typeof part === "string") return <Fragment key={`t${i}`}>{part}</Fragment>;
		if (part.kind === "ref") {
			return <TaskRefLink key={`r${part.key}`} taskRef={part.ref} contextProjectId={contextProjectId} taskId={taskId} preview={preview} />;
		}
		const label = part.label ?? pathLinkLabel(part.raw);
		return (
			<PathLink key={`p${part.key}`} path={part.path} line={part.line} contextProjectId={contextProjectId} taskId={taskId} label={label === part.raw ? undefined : label}>
				{part.raw}
			</PathLink>
		);
	});
}
