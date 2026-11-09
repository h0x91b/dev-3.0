import { useEffect, useRef, useState } from "react";
import { taskUsesWorktree, type Project, type Task } from "../../../shared/types";
import { useT } from "../../i18n";
import { api } from "../../rpc";
import { OPEN_SETTINGS_SECTION_EVENT } from "../../state";
import { registerCompletionOverlayHost, registerCompletionStrip, useCompletionOffer, useCompletionOverlayHosted, type CompletionOffer, type CompletionOfferAnswer } from "../../completion-offers";
import { WorktreeSettingsIcon } from "../TaskIcons";
import { toastClearanceRef } from "../../toast-clearance";
import { completionSkipsGitCheck, unsavedWorkWarning } from "../../utils/confirmTaskCompletion";
import { taskDialogInfo } from "../../utils/taskDialogInfo";
import TaskDialogSubjectCard from "../TaskDialogSubjectCard";

/** Pointer clicks count only after this long, so a click aimed at what was there before cannot answer. */
export const COMPLETION_STRIP_ARM_MS = 600;

type GitCheck = { state: "skipped" } | { state: "checking" } | { state: "done"; warning: string | null } | { state: "unknown" };

/**
 * The task's pending completion offer. An unsolicited one never takes focus or
 * keys, so an offer that lands while the user types cannot steal a keystroke; the
 * user's own Complete/Cancel focuses Keep open instead. It never covers the board.
 * `overlay` floats it over the top-right of a live terminal viewport, so the
 * terminal keeps its size; `inline` is the row under the inspector, used only
 * where no terminal viewport hosts the overlay (a session-ended screen).
 */
export default function TaskCompletionStrip({ task, project, variant = "inline", belowZoomBadge = false }: {
	task: Task; project: Project; variant?: "inline" | "overlay";
	/** The tmux ZOOMED badge holds the same corner; the overlay drops below it while it shows. */
	belowZoomBadge?: boolean;
}) {
	const offer = useCompletionOffer(task.id);
	const hosted = useCompletionOverlayHosted(task.id);
	useEffect(() => registerCompletionStrip(task.id), [task.id]);
	useEffect(() => (variant === "overlay" ? registerCompletionOverlayHost(task.id) : undefined), [task.id, variant]);
	if (!offer || (variant === "inline" && hosted)) return null;
	// The user's ask carries a full subject card: inline it would push the whole
	// task view down, so it floats from a zero-height anchor instead.
	if (variant === "inline" && offer.kind === "user") {
		return (
			<div className="relative z-30 h-0" data-testid="task-completion-strip-float">
				<Strip key={offer.id} offer={offer} task={task} project={project} overlay belowZoomBadge={false} />
			</div>
		);
	}
	return <Strip key={offer.id} offer={offer} task={task} project={project} overlay={variant === "overlay"} belowZoomBadge={belowZoomBadge} />;
}

function Strip({ offer, task, project, overlay, belowZoomBadge }: { offer: CompletionOffer; task: Task; project: Project; overlay: boolean; belowZoomBadge: boolean }) {
	const t = useT();
	// The user's own click asked for this one, so it answers at once and owns focus.
	const isUser = offer.kind === "user";
	const armedRef = useRef(isUser);
	const keepOpenRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!isUser) return;
		const mounted = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		keepOpenRef.current?.focus();
		// Hand focus back once the answer settles (the ✓ re-enables a frame later),
		// as the modal's focus trap does — unless the user already moved it.
		return () => {
			requestAnimationFrame(() => {
				const active = document.activeElement;
				if (active && active !== document.body) return;
				const target = [offer.returnFocus, mounted].find((el) => el?.isConnected && el !== document.body);
				target?.focus();
			});
		};
	}, [isUser, offer.returnFocus]);
	const skipGit = completionSkipsGitCheck(task, project);
	const [git, setGit] = useState<GitCheck>(skipGit ? { state: "skipped" } : { state: "checking" });

	useEffect(() => {
		if (isUser) return;
		const timer = setTimeout(() => { armedRef.current = true; }, COMPLETION_STRIP_ARM_MS);
		return () => clearTimeout(timer);
	}, []);

	const liveRef = useRef(true);
	const checkGit = (): Promise<GitCheck> => api.request.getUnsavedWork({ taskId: task.id, projectId: project.id })
		.then((status): GitCheck => ({ state: "done", warning: unsavedWorkWarning(status, t) }))
		.catch((): GitCheck => ({ state: "unknown" }));

	useEffect(() => {
		liveRef.current = true;
		if (!skipGit) void checkGit().then((next) => { if (liveRef.current) setGit(next); });
		return () => { liveRef.current = false; };
		// One check per offer: the strip is keyed by offer id.
	}, []);

	const answer = (value: CompletionOfferAnswer) => {
		if (!armedRef.current) return;
		offer.answer(value);
	};

	// An offer can wait for hours while the user keeps working, so the shown
	// check may be stale. Re-check on click; new losses show and need a second click.
	const complete = async () => {
		if (!armedRef.current || git.state === "checking") return;
		if (skipGit) return offer.answer(true);
		const shown = git.state === "done" ? git.warning : null;
		setGit({ state: "checking" });
		const next = await checkGit();
		if (!liveRef.current) return;
		setGit(next);
		const fresh = next.state === "done" ? next.warning : null;
		if (fresh && fresh !== shown) return;
		offer.answer(true);
	};
	const isAgent = offer.kind === "agent";
	const isCancel = isUser && offer.status === "cancelled";
	const checking = git.state === "checking";
	const title = isUser
		? t(isCancel ? "task.confirmCancelTitle" : "task.confirmCompleteTitle")
		: t(isAgent ? "completionStrip.agentTitle" : "completionStrip.mergedTitle");
	// The user's own ask keeps the exact footer of the dialog it replaces.
	const note = isUser
		? t(task.worktreePath ? "task.warnCompletionFooter" : isCancel ? "task.confirmCancelFooter" : "task.confirmCompleteFooter")
		: t(!taskUsesWorktree(project, task) ? "completionStrip.folderNote" : task.worktreePath ? "completionStrip.worktreeNote" : "completionStrip.sessionNote");

	return (
		<div
			ref={toastClearanceRef}
			role="region"
			aria-label={title}
			onKeyDown={isUser ? (e) => { if (e.key === "Escape") { e.stopPropagation(); answer(false); } } : undefined}
			data-testid="task-completion-strip"
			data-help-id="task.completion-strip"
			className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm ${
				overlay
					? `absolute ${belowZoomBadge ? "top-11" : "top-2"} right-3 z-20 w-[min(40rem,calc(100%-1.5rem))] rounded-xl border bg-overlay shadow-lg`
					: "flex-shrink-0 border-b bg-raised"
			} ${isAgent ? "border-accent/40" : isUser ? "border-edge" : "border-success/30"}`}
		>
			<div className={`flex items-center gap-2 min-w-0 flex-1 ${overlay ? "basis-full" : "basis-full md:basis-[18rem]"}`}>
				{isUser ? null : isAgent ? (
					<span className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-accent/15 text-accent">
						<span aria-hidden className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F06A9}"}</span>
						{t("confirmDialog.agentBadge")}
					</span>
				) : (
					<span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success/15 text-success text-xs">✓</span>
				)}
				<div className="min-w-0">
					<div className="font-medium text-fg">{title}</div>
					{isUser && <UserAskSubject task={task} project={project} />}
					<div className="text-xs text-fg-3">{note}</div>
					{checking && <div className="text-xs text-fg-3" role="status">{t("task.checkingBranchState")}</div>}
					{git.state === "unknown" && <div className="text-xs text-warning-strong">{t("task.branchStateUnknown")}</div>}
					{git.state === "done" && git.warning && (
						<div className="text-xs text-danger whitespace-pre-line" data-testid="task-completion-strip-warning">{git.warning}</div>
					)}
				</div>
			</div>
			<div className={`flex flex-wrap items-center gap-2 shrink-0 ${overlay ? "ml-auto" : "max-md:ml-auto"}`}>
				{offer.kind === "merge" && (
					<>
						<button
							type="button"
							onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, {
								detail: { section: "tasks", anchor: "suggest-completing-after-merge" },
							}))}
							aria-label={t("completionStrip.settings")}
							title={t("completionStrip.settings")}
							className="grid h-8 w-8 max-md:h-11 max-md:w-11 place-items-center rounded-lg text-fg-3 hover:text-fg hover:bg-raised-hover transition-colors"
						>
							<WorktreeSettingsIcon className="w-4 h-4" />
						</button>
						<button
							type="button"
							title={t("completionStrip.manualHint")}
							onClick={() => answer("manual")}
							className="px-3 py-1.5 max-md:min-h-11 text-xs whitespace-nowrap rounded-lg text-fg-2 hover:text-fg hover:bg-raised-hover transition-colors"
						>
							{t("app.branchMergedManualCompletion")}
						</button>
					</>
				)}
				<button
					ref={keepOpenRef}
					type="button"
					title={isUser ? undefined : t(isAgent ? "completionStrip.keepOpenAgentHint" : "completionStrip.keepOpenMergeHint")}
					onClick={() => answer(false)}
					className="px-3 py-1.5 max-md:min-h-11 text-xs whitespace-nowrap rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-raised-hover transition-colors"
				>
					{t("completionStrip.keepOpen")}
				</button>
				<button
					type="button"
					data-testid="task-completion-strip-complete"
					disabled={checking}
					onClick={() => void complete()}
					className={`px-3 py-1.5 max-md:min-h-11 text-xs whitespace-nowrap rounded-lg text-white transition-colors ${
						checking ? "bg-fg-muted/40 cursor-not-allowed" : "bg-danger hover:bg-danger/80"
					}`}
				>
					{isUser ? t(isCancel ? "task.confirmCancelLabel" : "task.confirmCompleteLabel") : t("app.branchMergedComplete")}
				</button>
			</div>
		</div>
	);
}

/** The same subject card the completion dialog showed: which task, its overview, priority and labels. */
function UserAskSubject({ task, project }: { task: Task; project: Project }) {
	return <div className="my-1.5"><TaskDialogSubjectCard {...taskDialogInfo(task, project)} tone="accent" /></div>;
}
