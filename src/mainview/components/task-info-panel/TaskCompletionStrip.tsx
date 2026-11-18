import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isAttachedRepoInTaskFolder, taskUsesWorktree, type Project, type Task } from "../../../shared/types";
import { useT, type TFunction } from "../../i18n";
import { api } from "../../rpc";
import { OPEN_SETTINGS_SECTION_EVENT } from "../../state";
import { keepTaskOpen, registerCompletionOverlayHost, registerCompletionStrip, useCompletionOverlayHosted, useTaskStripOffer, type CompletionOffer, type CompletionOfferAnswer } from "../../completion-offers";
import { WorktreeSettingsIcon } from "../TaskIcons";
import ApprovalReasonNote from "../ApprovalReasonNote";
import { toastClearanceRef } from "../../toast-clearance";
import { completionSkipsGitCheck, unsavedWorkWarning } from "../../utils/confirmTaskCompletion";
import { useTaskPaneState } from "../../hooks/useTaskPaneState";
import { runPaneAction } from "../../pane-state-bus";
import { toast } from "../../toast";
import type { TaskPaneState } from "../../../shared/task-panes";

/** Pointer clicks count only after this long, so a click aimed at what was there before cannot answer. */
export const COMPLETION_STRIP_ARM_MS = 600;

type GitCheck = { state: "skipped" } | { state: "checking" } | { state: "done"; warning: string | null } | { state: "unknown" };

/**
 * The task's waiting merge or agent completion offer, when `completionOfferStyle`
 * is "inline". It never takes focus or keys, so an offer that lands while the user
 * types cannot steal a keystroke, and it never covers the board. `overlay` floats
 * it as a one-line bar at the bottom-right of the agent's pane, next to its latest
 * output and prompt, so the terminal keeps its size. `inline` is the row under the
 * inspector, used only where no terminal viewport hosts the overlay.
 */
export default function TaskCompletionStrip({ task, project, variant = "inline" }: {
	task: Task; project: Project; variant?: "inline" | "overlay";
}) {
	const offer = useTaskStripOffer(task.id);
	const hosted = useCompletionOverlayHosted(task.id);
	const paneState = useTaskPaneState(task.id);
	useEffect(() => registerCompletionStrip(task.id), [task.id]);
	useEffect(() => (variant === "overlay" ? registerCompletionOverlayHost(task.id) : undefined), [task.id, variant]);
	if (!offer || (variant === "inline" && hosted)) return null;
	if (variant === "inline") return <Strip key={offer.id} offer={offer} task={task} project={project} bar={false} />;
	const placement = agentPanePlacement(paneState);
	const revealPaneId = placement === "hidden" && offer.kind === "agent" ? paneState?.agentPaneId ?? undefined : undefined;
	// Always the same wrapper, so splitting, zooming or switching windows never remounts the bar.
	const insets = typeof placement === "string" ? { inset: 0 } : placement;
	return (
		<div className="pointer-events-none absolute z-20 [&>*]:pointer-events-auto" style={insets} data-testid="task-completion-strip-pane">
			<Strip key={offer.id} offer={offer} task={task} project={project} bar revealPaneId={revealPaneId} />
		</div>
	);
}

/**
 * Where the bar goes, so it sits beside the prompt the agent waits at: the agent
 * pane's insets of the terminal area, or the whole terminal when the agent fills it
 * or its pane is unknown or gone. "hidden" means the agent's pane is out of view, under
 * another zoomed pane or in another tmux window: the bar spans the terminal and
 * offers to show the agent.
 */
export function agentPanePlacement(state: TaskPaneState | null): CSSProperties | "terminal" | "hidden" {
	if (!state) return "terminal";
	// A backend that does not report agentPaneId yet: the agent runs in the first pane.
	const agentPaneId = state.agentPaneId === undefined ? [...state.panes].sort((a, b) => a.index - b.index)[0]?.paneId : state.agentPaneId;
	if (!agentPaneId) return "terminal";
	const agent = state.panes.find((pane) => pane.paneId === agentPaneId);
	if (!agent) return "hidden";
	if (state.zoomedPaneId) return state.zoomedPaneId === agent.paneId ? "terminal" : "hidden";
	if (state.panes.length < 2) return "terminal";
	const pct = (value: number) => `${Math.max(0, Math.min(1, value)) * 100}%`;
	return {
		left: pct(agent.rect.x),
		right: pct(1 - agent.rect.x - agent.rect.width),
		top: pct(agent.rect.y),
		bottom: pct(1 - agent.rect.y - agent.rect.height),
	};
}

/** What completing removes: the worktree and the session, the session, or the session but not the folder. */
export function completionOfferNote(task: Task, project: Project, t: TFunction): string {
	const note = t(!taskUsesWorktree(project, task) ? "completionStrip.folderNote" : task.worktreePath ? "completionStrip.worktreeNote" : "completionStrip.sessionNote");
	return isAttachedRepoInTaskFolder(task) ? `${note} ${t("task.attachedWorktreeNote")}` : note;
}

/**
 * `bar` is the one-line overlay: no taller than the two hint rows under an agent's
 * input box, its note opening upward on hover or focus while the title and buttons
 * stay on the bottom line, so nothing moves under the pointer.
 */
function Strip({ offer, task, project, bar, revealPaneId }: {
	offer: CompletionOffer; task: Task; project: Project; bar: boolean; revealPaneId?: string;
}) {
	const t = useT();
	const reveal = () => {
		if (!revealPaneId) return;
		runPaneAction(task.id, { kind: "reveal", paneId: revealPaneId }).catch((err) => {
			toast.error(t("completionStrip.showAgentFailed", { error: err instanceof Error ? err.message : String(err) }), { taskId: task.id });
		});
	};
	const armedRef = useRef(false);
	const skipGit = completionSkipsGitCheck(task, project);
	const [git, setGit] = useState<GitCheck>(skipGit ? { state: "skipped" } : { state: "checking" });
	// Set once a click was held back for new losses: then the warning says why, hover or not.
	const [held, setHeld] = useState(false);

	// Filled after mount: a live region announces a change, not the text it was born with.
	const [announcement, setAnnouncement] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => { armedRef.current = true; }, COMPLETION_STRIP_ARM_MS);
		const announce = setTimeout(() => setAnnouncement(t(offer.kind === "agent" ? "completionStrip.agentTitle" : "completionStrip.mergedTitle")), 100);
		return () => { clearTimeout(timer); clearTimeout(announce); };
		// One announcement per offer: the strip is keyed by offer id.
	}, []);
	const liveRegion = <span role="status" className="sr-only" data-testid="task-completion-strip-announcement">{announcement}</span>;

	const liveRef = useRef(true);
	// An agent's ask checks the repo its request saw; only a successful check approves removing it.
	const expectedAttachedRepo = offer.attachedWorktree ? offer.attachedWorktree.repo : task.attachedRepo ?? null;
	const checkGit = (): Promise<GitCheck> => api.request.getUnsavedWork({ taskId: task.id, projectId: project.id, expectedAttachedRepo })
		.then((status): GitCheck => {
			offer.attachedWorktree?.onChecked(expectedAttachedRepo);
			return { state: "done", warning: unsavedWorkWarning(status, t) };
		})
		.catch((): GitCheck => ({ state: "unknown" }));

	useEffect(() => {
		liveRef.current = true;
		if (!skipGit) void checkGit().then((next) => { if (liveRef.current) setGit(next); });
		return () => { liveRef.current = false; };
		// One check per offer: the strip is keyed by offer id.
	}, []);

	const answer = (value: CompletionOfferAnswer) => {
		if (!armedRef.current) return;
		if (value === false) keepTaskOpen(offer.taskId);
		else offer.answer(value);
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
		if (fresh && fresh !== shown) {
			setHeld(true);
			return;
		}
		offer.answer(true);
	};
	const isAgent = offer.kind === "agent";
	const checking = git.state === "checking";
	const title = t(isAgent ? "completionStrip.agentTitle" : "completionStrip.mergedTitle");
	const note = completionOfferNote(task, project, t);
	const buttonPad = bar ? "py-1" : "py-1.5";
	// The bar stays one line: its note and git state open upward on hover or focus,
	// which reaching Complete always passes through.
	const hoverOnly = bar ? "hidden group-hover:block group-focus-within:block" : "";

	return (
		<div
			ref={bar ? undefined : toastClearanceRef}
			role="region"
			aria-label={title}
			data-testid="task-completion-strip"
			data-help-id="task.completion-strip"
			data-layout={bar ? "terminal" : "row"}
			className={`group flex flex-wrap ${bar ? "items-end" : "items-center"} gap-x-3 gap-y-2 text-sm ${bar ? "px-2 py-1" : "px-3 py-2"} ${
				bar
					// On a wide terminal the corner is far from the prompt, so the bar stops within 72rem of the pane's left edge.
					? "absolute bottom-1 right-[max(0.75rem,calc(100%-72rem))] z-20 max-w-[min(40rem,calc(100%-1.5rem))] rounded-xl border bg-overlay shadow-lg"
					: "flex-shrink-0 border-b bg-raised"
			} ${isAgent ? "border-accent/40" : "border-success/30"}`}
		>
			{liveRegion}
			<div className={`flex ${bar ? "items-end basis-[14rem]" : "items-center basis-full md:basis-[18rem]"} gap-2 min-w-0 flex-1`}>
				{isAgent ? (
					// The bar keeps the badge's glyph and colour; its label moves to the tooltip.
					<span className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-accent/15 text-accent" title={bar ? t("confirmDialog.agentBadge") : undefined}>
						<span aria-hidden className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F06A9}"}</span>
						{bar ? <span className="sr-only">{t("confirmDialog.agentBadge")}</span> : t("confirmDialog.agentBadge")}
					</span>
				) : (
					<span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success/15 text-success text-xs">✓</span>
				)}
				<div className={bar ? "min-w-0 flex flex-col-reverse" : "min-w-0"}>
					<div className={`font-medium text-fg ${bar ? "truncate" : ""}`} title={bar ? title : undefined}>{title}</div>
					<div className={`text-xs text-fg-3 ${hoverOnly}`} data-testid="task-completion-strip-note">{note}</div>
					{offer.reason && (
						<div className={bar ? `${hoverOnly} pb-1` : "pt-1"}>
							<ApprovalReasonNote reason={offer.reason} tone="danger" />
						</div>
					)}
					{checking && !bar && <div className="text-xs text-fg-3" role="status">{t("task.checkingBranchState")}</div>}
					{git.state === "unknown" && <div className={`text-xs text-warning-strong ${hoverOnly}`}>{t("task.branchStateUnknown")}</div>}
					{git.state === "done" && git.warning && (
						<div className={`text-xs text-danger whitespace-pre-line ${held ? "" : hoverOnly}`} data-testid="task-completion-strip-warning">{git.warning}</div>
					)}
				</div>
			</div>
			<div className={`flex flex-wrap items-center gap-2 shrink-0 ${bar ? "ml-auto" : "max-md:ml-auto"}`}>
				{offer.kind === "merge" && (
					<>
						<button
							type="button"
							onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, {
								detail: { section: "tasks", anchor: "suggest-completing-after-merge" },
							}))}
							aria-label={t("completionStrip.settings")}
							title={t("completionStrip.settings")}
							className={`grid ${bar ? "h-6 w-6" : "h-8 w-8"} max-md:h-11 max-md:w-11 place-items-center rounded-lg text-fg-3 hover:text-fg hover:bg-raised-hover transition-colors`}
						>
							<WorktreeSettingsIcon className="w-4 h-4" />
						</button>
						<button
							type="button"
							title={t("completionStrip.manualHint")}
							onClick={() => answer("manual")}
							className={`px-3 ${buttonPad} max-md:min-h-11 text-xs whitespace-nowrap rounded-lg text-fg-2 hover:text-fg hover:bg-raised-hover transition-colors`}
						>
							{t("app.branchMergedManualCompletion")}
						</button>
					</>
				)}
				{revealPaneId && (
					<button
						type="button"
						onClick={reveal}
						aria-label={t("completionStrip.showAgent")}
						title={t("completionStrip.showAgentHint")}
						data-testid="task-completion-strip-show-agent"
						className="grid h-6 w-6 max-md:h-11 max-md:w-11 place-items-center rounded-lg text-fg-3 hover:text-fg hover:bg-raised-hover transition-colors"
					>
						<svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></svg>
					</button>
				)}
				<button
					type="button"
					title={t(isAgent ? "completionStrip.keepOpenAgentHint" : "completionStrip.keepOpenMergeHint")}
					onClick={() => answer(false)}
					className={`px-3 ${buttonPad} max-md:min-h-11 text-xs whitespace-nowrap rounded-lg border border-edge text-fg-2 hover:text-fg hover:bg-raised-hover transition-colors`}
				>
					{t("completionStrip.keepOpen")}
				</button>
				<button
					type="button"
					data-testid="task-completion-strip-complete"
					disabled={checking}
					onClick={() => void complete()}
					className={`px-3 ${buttonPad} max-md:min-h-11 text-xs whitespace-nowrap rounded-lg text-white transition-colors ${
						checking ? "bg-fg-muted/40 cursor-not-allowed" : "bg-danger-fill hover:bg-danger-fill-hover"
					}`}
				>
					{t("app.branchMergedComplete")}
				</button>
			</div>
		</div>
	);
}
