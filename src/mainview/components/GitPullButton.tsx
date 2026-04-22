import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";

interface GitPullButtonProps {
	projectId: string;
}

const PULLABLE_BRANCHES = new Set(["main", "master"]);
const BRANCH_POLL_MS = 15_000;

function GitPullButton({ projectId }: GitPullButtonProps) {
	const t = useT();
	const [branch, setBranch] = useState<string | null | undefined>(undefined);
	const [pulling, setPulling] = useState(false);
	const mountedRef = useRef(true);

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
		};
	}, [refreshBranch]);

	const canPull = typeof branch === "string" && PULLABLE_BRANCHES.has(branch);
	const disabled = !canPull || pulling;

	async function handleClick() {
		if (disabled) return;
		setPulling(true);
		try {
			const result = await api.request.pullProjectMain({ projectId });
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

	// Use the same shape/size as other GlobalHeader buttons
	// (Project Terminal, Changelog, Report, etc.). Active/working state mirrors Project Terminal.
	const baseClass = "flex items-center gap-1 transition-colors px-2 py-1 rounded-lg";
	const stateClass = pulling
		? "text-accent bg-accent/15"
		: disabled
			? "text-fg-muted cursor-not-allowed opacity-60"
			: "text-fg-3 hover:text-fg hover:bg-elevated";

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={disabled}
			data-testid="git-pull-button"
			className={`${baseClass} ${stateClass}`}
			title={title}
			aria-label={title}
		>
			<span
				className={`text-[1.125rem] leading-none${pulling ? " animate-spin inline-block" : ""}`}
				style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				aria-hidden="true"
			>
				{/* nf-md-cloud_download_outline / nf-md-refresh while pulling */}
				{pulling ? "\u{F0450}" : "\u{F0164}"}
			</span>
			<span className="text-[0.6875rem] font-medium">{t("header.gitPullLabel")}</span>
		</button>
	);
}

export default GitPullButton;
