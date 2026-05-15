import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";
import GitPullErrorModal from "./GitPullErrorModal";

interface GitPullButtonProps {
	projectId: string;
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

function GitPullButton({ projectId }: GitPullButtonProps) {
	const t = useT();
	const [branch, setBranch] = useState<string | null | undefined>(undefined);
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
			})
			.catch(() => {
				if (!mountedRef.current) return;
				setBranch(null);
			});
	}, [projectId]);

	useEffect(() => {
		mountedRef.current = true;
		refreshBranch();
		const interval = setInterval(refreshBranch, BRANCH_POLL_MS);
		return () => {
			mountedRef.current = false;
			clearInterval(interval);
			if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		};
	}, [refreshBranch]);

	// Reset transient state (flash, modal, branch) when the user switches projects —
	// otherwise the green/red flash leaks across projects and so does the error modal.
	useEffect(() => {
		setBranch(undefined);
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
	let icon: string;
	let iconSpin = false;
	let label: string;

	const baseClass = "flex items-center gap-1 transition-colors px-2 py-1 rounded-lg";

	if (pulling) {
		title = t("kanban.gitPullInProgress");
		stateClass = "text-accent bg-accent/15";
		icon = "\u{F0450}"; // refresh
		iconSpin = true;
		label = t("header.gitPullLabel");
	} else if (lastResult) {
		switch (lastResult.kind) {
			case "pulled":
				title = t("kanban.gitPullFlashPulled", { branch: lastResult.branch });
				// Use semantic success color — matches status-completed in STATUS_COLORS
				stateClass = "bg-[#10b981]/15 text-[#10b981]";
				icon = "\u{F0E1E}"; // nf-md-check_circle_outline
				label = t("kanban.gitPullFlashPulledLabel");
				break;
			case "up-to-date":
				title = t("kanban.gitPullFlashUpToDate", { branch: lastResult.branch });
				stateClass = "bg-[#10b981]/10 text-[#10b981]";
				icon = "\u{F0E1E}"; // nf-md-check_circle_outline
				label = t("kanban.gitPullFlashUpToDateLabel");
				break;
			case "failed":
				title = t("kanban.gitPullFlashFailed", { branch: lastResult.branch });
				stateClass = "bg-danger/15 text-danger";
				icon = "\u{F0027}"; // nf-md-alert_circle
				label = t("kanban.gitPullFlashFailedLabel");
				break;
		}
	} else if (canPull && typeof branch === "string") {
		title = t("kanban.gitPullTooltip", { branch });
		stateClass = "text-fg-3 hover:text-fg hover:bg-elevated";
		icon = "\u{F0164}"; // cloud_download_outline
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
		icon = "\u{F0164}";
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
			>
				<span
					className={`text-[1.125rem] leading-none${iconSpin ? " animate-spin inline-block" : ""}`}
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					aria-hidden="true"
				>
					{icon}
				</span>
				<span className="text-[0.6875rem] font-medium">{label}</span>
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
