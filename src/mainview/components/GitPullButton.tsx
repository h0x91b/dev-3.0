import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import { startVisibilityAwarePoll } from "../utils/poll";
import { useReducedMotion } from "../utils/useReducedMotion";
import GitPullErrorModal from "./GitPullErrorModal";
import { PullIcon, PullSuccessIcon, PullAlertIcon } from "./HeaderIcons";

type PullIconComponent = typeof PullIcon;

interface GitPullButtonProps {
	projectId: string;
	compact?: boolean;
}

interface PullError {
	branch: string;
	error: string;
}

const PULLABLE_BRANCHES = new Set(["main", "master"]);
const BRANCH_POLL_MS = 15_000;
const RESULT_FLASH_MS = 3_000;

type PullResult =
	| { kind: "pulled"; branch: string }
	| { kind: "up-to-date"; branch: string }
	| { kind: "failed"; branch: string };

/** Classify successful pull stdout: "Already up to date." → up-to-date, else → pulled. */
function classifySuccess(output: string): "pulled" | "up-to-date" {
	return /already up to date/i.test(output) ? "up-to-date" : "pulled";
}

function GitPullButton({ projectId, compact = false }: GitPullButtonProps) {
	const t = useT();
	const reducedMotion = useReducedMotion();
	const [branch, setBranch] = useState<string | null | undefined>(undefined);
	const [behindOrigin, setBehindOrigin] = useState(0);
	const [pulling, setPulling] = useState(false);
	const [lastResult, setLastResult] = useState<PullResult | null>(null);
	const [pullError, setPullError] = useState<PullError | null>(null);
	const mountedRef = useRef(true);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refreshBranch = useCallback(() => {
		api.request
			.getProjectCurrentBranch({ projectId })
			.then((result) => {
				if (!mountedRef.current) return;
				setBranch(result.branch);
				setBehindOrigin(result.behindOrigin ?? 0);
			})
			.catch(() => {
				if (!mountedRef.current) return;
				setBranch(null);
				setBehindOrigin(0);
			});
	}, [projectId]);

	useEffect(() => {
		mountedRef.current = true;
		const stop = startVisibilityAwarePoll({ fn: refreshBranch, intervalMs: BRANCH_POLL_MS });
		return () => {
			mountedRef.current = false;
			stop();
			if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		};
	}, [refreshBranch]);

	// Reset transient state (flash, modal, branch) when the user switches projects —
	// otherwise the green/red flash leaks across projects and so does the error modal.
	useEffect(() => {
		setBranch(undefined);
		setBehindOrigin(0);
		setLastResult(null);
		setPullError(null);
		if (flashTimerRef.current) {
			clearTimeout(flashTimerRef.current);
			flashTimerRef.current = null;
		}
	}, [projectId]);

	const flashResult = useCallback((result: PullResult) => {
		setLastResult(result);
		if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		flashTimerRef.current = setTimeout(() => {
			if (!mountedRef.current) return;
			setLastResult(null);
			flashTimerRef.current = null;
		}, RESULT_FLASH_MS);
	}, []);

	const canPull = typeof branch === "string" && PULLABLE_BRANCHES.has(branch);
	const disabled = !canPull || pulling;

	const runPull = useCallback(async () => {
		// Clear any previous flash immediately so user sees the new pull start fresh
		if (flashTimerRef.current) {
			clearTimeout(flashTimerRef.current);
			flashTimerRef.current = null;
		}
		setLastResult(null);
		setPulling(true);
		try {
			const result = await api.request.pullProjectMain({ projectId });
			const displayBranch = result.branch ?? branch ?? "";
			if (result.ok) {
				const kind = classifySuccess(result.output);
				flashResult({ kind, branch: displayBranch });
				setPullError(null);
				setBehindOrigin(0);
				// Success path is silent — the button flash is the feedback.
				// Details are available via the worktree git log if the user wants them.
			} else {
				flashResult({ kind: "failed", branch: displayBranch });
				const errorMsg = result.error.trim() || t("kanban.gitPullFailedUnknown");
				setPullError({ branch: displayBranch, error: errorMsg });
			}
			refreshBranch();
		} catch (err) {
			flashResult({ kind: "failed", branch: branch ?? "?" });
			setPullError({ branch: branch ?? "?", error: String(err) });
		} finally {
			if (mountedRef.current) {
				setPulling(false);
			}
		}
	}, [branch, flashResult, projectId, refreshBranch, t]);

	function handleClick() {
		if (disabled) return;
		void runPull();
	}

	function handleRetry() {
		void runPull();
	}

	function handleCloseError() {
		setPullError(null);
	}

	// Compute visuals: pulling > flash > normal
	let title: string;
	let stateClass: string;
	let IconComp: PullIconComponent = PullIcon;
	let iconSpin = false;
	let label: string;

	const baseClass = "header-anim flex items-center gap-1 transition-colors px-1.5 py-1 rounded-lg";

	if (pulling) {
		title = t("kanban.gitPullInProgress");
		stateClass = "text-accent bg-accent/15";
		iconSpin = true;
		label = t("header.gitPullLabel");
	} else if (lastResult) {
		switch (lastResult.kind) {
			case "pulled":
				title = t("kanban.gitPullFlashPulled", { branch: lastResult.branch });
				// Use semantic success color — matches status-completed in STATUS_COLORS
				stateClass = "bg-[#10b981]/15 text-[#10b981]";
				IconComp = PullSuccessIcon;
				label = t("kanban.gitPullFlashPulledLabel");
				break;
			case "up-to-date":
				title = t("kanban.gitPullFlashUpToDate", { branch: lastResult.branch });
				stateClass = "bg-[#10b981]/10 text-[#10b981]";
				IconComp = PullSuccessIcon;
				label = t("kanban.gitPullFlashUpToDateLabel");
				break;
			case "failed":
				title = t("kanban.gitPullFlashFailed", { branch: lastResult.branch });
				stateClass = "bg-danger/15 text-danger";
				IconComp = PullAlertIcon;
				label = t("kanban.gitPullFlashFailedLabel");
				break;
		}
	} else if (canPull && typeof branch === "string") {
		if (behindOrigin > 0) {
			// Quiet "new commits available" hint — accent tint only, no fill/pulse
			// (those are reserved for the loud "Update ready" header indicator).
			title = t.plural("kanban.gitPullBehind", behindOrigin, { branch });
			stateClass = "text-accent/80 hover:text-accent hover:bg-accent/10";
		} else {
			title = t("kanban.gitPullTooltip", { branch });
			stateClass = "text-fg-3 hover:text-fg hover:bg-elevated";
		}
		label = t("header.gitPullLabel");
	} else {
		if (branch === null) {
			title = t("kanban.gitPullDisabledDetached");
		} else if (typeof branch === "string") {
			title = t("kanban.gitPullDisabledBranch", { branch });
		} else {
			title = t("kanban.gitPullDisabledUnknown");
		}
		stateClass = "text-fg-muted cursor-not-allowed opacity-60";
		label = t("header.gitPullLabel");
	}

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				disabled={disabled}
				data-testid="git-pull-button"
				data-pull-flash={lastResult?.kind ?? undefined}
				className={`${baseClass} ${stateClass}`}
				title={title}
				aria-label={title}
				data-behind-origin={behindOrigin > 0 ? behindOrigin : undefined}
			>
				<span className="relative inline-flex items-center justify-center w-[1.125rem] h-[1.125rem]" aria-hidden="true">
					{iconSpin ? (
						// Pull in progress: a circular ring spinner. A ring is radially symmetric, so
						// animate-spin rotates it perfectly around its own center — zero wobble. (A
						// spinning Nerd Font glyph wobbles instead, because its ink center never lines
						// up with its advance-width × line-height layout box.) The fixed-size icon slot
						// above is shared by the idle glyph and this ring, so the icon does not shift
						// sideways when the spin starts; the ring is sized below the slot so it reads no
						// larger than the neighboring toolbar icons.
						<span
							data-testid="git-pull-spinner"
							className={`w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current${reducedMotion ? "" : " animate-spin"}`}
						/>
					) : (
						<IconComp className="w-[1.125rem] h-[1.125rem]" />
					)}
					{behindOrigin > 0 && !pulling && !lastResult && (
						<span
							className="absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full bg-accent"
							data-testid="git-pull-behind-dot"
						/>
					)}
				</span>
				{!compact && <span className="text-[0.6875rem] font-medium">{label}</span>}
			</button>
			{pullError && (
				<GitPullErrorModal
					branch={pullError.branch}
					error={pullError.error}
					retrying={pulling}
					onRetry={handleRetry}
					onClose={handleCloseError}
				/>
			)}
		</>
	);
}

export default GitPullButton;
