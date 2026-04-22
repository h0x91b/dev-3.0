import { useState, useEffect, useCallback, useRef } from "react";
import type { Project } from "../../shared/types";
import { api } from "../rpc";
import { useT } from "../i18n";

interface GitPullButtonProps {
	project: Project;
}

const PULLABLE_BRANCHES = new Set(["main", "master"]);
const BRANCH_POLL_MS = 15_000;

function GitPullButton({ project }: GitPullButtonProps) {
	const t = useT();
	const [branch, setBranch] = useState<string | null | undefined>(undefined);
	const [pulling, setPulling] = useState(false);
	const mountedRef = useRef(true);

	const refreshBranch = useCallback(() => {
		api.request
			.getProjectCurrentBranch({ projectId: project.id })
			.then((result) => {
				if (!mountedRef.current) return;
				setBranch(result.branch);
			})
			.catch(() => {
				if (!mountedRef.current) return;
				setBranch(null);
			});
	}, [project.id]);

	useEffect(() => {
		mountedRef.current = true;
		refreshBranch();
		const interval = setInterval(refreshBranch, BRANCH_POLL_MS);
		return () => {
			mountedRef.current = false;
			clearInterval(interval);
		};
	}, [refreshBranch]);

	const canPull = typeof branch === "string" && PULLABLE_BRANCHES.has(branch);
	const disabled = !canPull || pulling;

	async function handleClick() {
		if (disabled) return;
		setPulling(true);
		try {
			const result = await api.request.pullProjectMain({ projectId: project.id });
			const displayBranch = result.branch ?? branch ?? "";
			if (result.ok) {
				const body = result.output.trim() || t("kanban.gitPullUpToDate");
				alert(`${t("kanban.gitPullSuccessTitle", { branch: displayBranch })}\n\n${body}`);
			} else {
				const errorMsg = result.error.trim() || t("kanban.gitPullFailedUnknown");
				alert(`${t("kanban.gitPullFailedTitle", { branch: displayBranch })}\n\n${errorMsg}`);
			}
			refreshBranch();
		} catch (err) {
			alert(
				`${t("kanban.gitPullFailedTitle", { branch: branch ?? "?" })}\n\n${String(err)}`,
			);
		} finally {
			if (mountedRef.current) {
				setPulling(false);
			}
		}
	}

	let title: string;
	if (pulling) {
		title = t("kanban.gitPullInProgress");
	} else if (canPull && typeof branch === "string") {
		title = t("kanban.gitPullTooltip", { branch });
	} else if (branch === null) {
		title = t("kanban.gitPullDisabledDetached");
	} else if (typeof branch === "string") {
		title = t("kanban.gitPullDisabledBranch", { branch });
	} else {
		title = t("kanban.gitPullDisabledUnknown");
	}

	const iconClassSpinning = pulling ? " animate-spin inline-block" : "";

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={disabled}
			data-testid="git-pull-button"
			className={`flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors flex-shrink-0 ${
				disabled
					? "text-fg-muted cursor-not-allowed"
					: "text-fg-3 hover:text-fg hover:bg-elevated"
			}`}
			title={title}
			aria-label={title}
		>
			<span
				className={`text-sm leading-none${iconClassSpinning}`}
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				aria-hidden="true"
			>
				{/* Nerd Font: nf-md-cloud_download_outline (pull) / nf-md-refresh (spinning) */}
				{pulling ? "\u{F0450}" : "\u{F0164}"}
			</span>
			<span>{pulling ? t("kanban.gitPullInProgress") : t("kanban.gitPull")}</span>
			{typeof branch === "string" && (
				<span className="text-fg-muted">
					{t("kanban.gitPullBranchLabel", { branch })}
				</span>
			)}
		</button>
	);
}

export default GitPullButton;
