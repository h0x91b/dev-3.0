import { useT } from "../i18n";
import { useRpcStatus } from "../hooks/useDiagnostics";

/**
 * Board-level error state: the task fetch failed and there is nothing cached to
 * show. Names the likely cause (transport down vs. server error) and offers the
 * retry the old code only ever logged to a console the remote user cannot open.
 */
export default function BoardLoadFailed({ onRetry }: { onRetry: () => void }) {
	const t = useT();
	const rpcState = useRpcStatus();
	const offline = rpcState !== "connected";

	return (
		<div className="flex-1 min-h-0 flex items-center justify-center p-6" data-testid="board-load-failed">
			<div className="w-full max-w-sm bg-raised border border-edge rounded-2xl p-6 space-y-3 text-center">
				<span
					className="text-warning-strong text-2xl leading-none block"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\uf071"}
				</span>
				<h2 className="text-fg text-base font-semibold">{t("kanban.loadFailed")}</h2>
				<p className="text-fg-3 text-sm">
					{offline ? t("kanban.loadFailedOffline") : t("kanban.loadFailedDesc")}
				</p>
				<button
					type="button"
					onClick={onRetry}
					className="px-4 py-2 text-sm rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors"
				>
					{t("kanban.loadRetry")}
				</button>
			</div>
		</div>
	);
}
