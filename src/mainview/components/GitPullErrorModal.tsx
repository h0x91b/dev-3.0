import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

interface GitPullErrorModalProps {
	branch: string;
	error: string;
	retrying: boolean;
	onRetry: () => void;
	onClose: () => void;
}

function GitPullErrorModal({ branch, error, retrying, onRetry, onClose }: GitPullErrorModalProps) {
	const t = useT();

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		}
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, [onClose]);

	// Render through a portal into document.body — the kanban GlobalHeader uses
	// `backdrop-filter`, which establishes a containing block for `position:
	// fixed` descendants. Without the portal, `fixed inset-0` would be relative
	// to the (~50px tall) header bar, pushing the modal off the top of the
	// viewport. See decisions/-stacking-context-fixed-positioning.md.
	return createPortal(
		<div
			data-git-pull-error-modal="true"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
		>
			{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
			<div
				className="relative bg-overlay border border-edge rounded-2xl shadow-2xl w-[42rem] max-w-[90vw] max-h-[80vh] flex flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-edge">
					<div className="flex items-center gap-2 min-w-0">
						<span
							className="text-[1.25rem] leading-none text-danger shrink-0"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-hidden="true"
						>
							{"\u{F0027}"}
						</span>
						<h2 className="text-fg text-lg font-semibold truncate">
							{t("kanban.gitPullFailedTitle", { branch })}
						</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="text-fg-muted hover:text-fg transition-colors p-1 -mr-1 rounded-lg hover:bg-fg/5 shrink-0"
						aria-label={t("kanban.gitPullErrorClose")}
					>
						<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				<div className="px-6 py-4 overflow-auto flex-1">
					<pre
						data-testid="git-pull-error-text"
						className="text-fg-2 text-xs font-mono whitespace-pre-wrap break-words bg-elevated border border-edge rounded-xl p-3 select-text"
					>
						{error || t("kanban.gitPullFailedUnknown")}
					</pre>
				</div>

				<div className="flex items-center justify-end gap-2 px-6 pt-2 pb-6">
					<button
						type="button"
						onClick={onClose}
						disabled={retrying}
						className="px-4 py-2 text-sm font-medium text-fg-2 hover:text-fg bg-elevated hover:bg-elevated-hover border border-edge rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{t("kanban.gitPullErrorClose")}
					</button>
					<button
						type="button"
						onClick={onRetry}
						disabled={retrying}
						data-testid="git-pull-error-retry"
						className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
					>
						<span
							className={`text-[1rem] leading-none${retrying ? " animate-spin inline-block" : ""}`}
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							aria-hidden="true"
						>
							{"\u{F0450}"}
						</span>
						{retrying ? t("kanban.gitPullInProgress") : t("kanban.gitPullErrorRetry")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

export default GitPullErrorModal;
