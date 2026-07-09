import { useState } from "react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useDiagnostics } from "../hooks/useDiagnostics";
import { clearDiagnostics, formatDiagnosticsForCopy, type DiagnosticEntry, type DiagnosticKind } from "../diagnostics";
import { copyTextToClipboard } from "../utils/clipboard";

const KIND_LABEL: Record<DiagnosticKind, TranslationKey> = {
	error: "diagnostics.kind.error",
	rejection: "diagnostics.kind.rejection",
	react: "diagnostics.kind.react",
	rpc: "diagnostics.kind.rpc",
};

function levelColor(level: DiagnosticEntry["level"]): string {
	if (level === "error") return "text-danger";
	if (level === "warn") return "text-warning";
	return "text-fg-3";
}

function formatTime(ts: number): string {
	try {
		return new Date(ts).toLocaleTimeString();
	} catch {
		return "";
	}
}

/**
 * Full diagnostics viewer — the in-UI black box for remote/mobile where there is
 * no devtools. Lists every captured fault (newest first) with a copyable dump,
 * so the user can see what broke and paste it into a bug report. Viewport-clamped
 * so it fits a phone; pure React (works identically in desktop and browser).
 *
 * Opened via the {@link DIAGNOSTICS_OPEN_EVENT} window event (from the floating
 * indicator or a menu action); `App` owns the open flag and renders this.
 */
export default function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const entries = useDiagnostics();
	const [copied, setCopied] = useState(false);
	useEscapeKey(onClose);

	const ordered = entries.slice().reverse();

	const handleCopy = async () => {
		const ok = await copyTextToClipboard(formatDiagnosticsForCopy());
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	return (
		<div
			className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-label={t("diagnostics.title")}
				tabIndex={-1}
				className="bg-overlay border border-edge sm:rounded-2xl rounded-t-2xl shadow-2xl w-full sm:w-[34rem] max-w-full sm:max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] flex flex-col outline-none"
			>
				{/* Header */}
				<div className="flex items-start gap-3 p-4 border-b border-edge">
					<span
						className="text-accent text-2xl leading-none mt-0.5 flex-shrink-0"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\uf188"}
					</span>
					<div className="flex-1 min-w-0">
						<h2 className="text-fg text-lg font-semibold leading-tight">{t("diagnostics.title")}</h2>
						<p className="text-fg-3 text-sm">{t("diagnostics.subtitle")}</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("diagnostics.close")}
						className="text-fg-muted hover:text-fg transition-colors flex-shrink-0 p-1"
					>
						<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Body */}
				<div className="flex-1 min-h-0 overflow-auto p-4 space-y-2.5">
					{ordered.length === 0 ? (
						<div className="text-fg-3 text-sm text-center py-8">{t("diagnostics.empty")}</div>
					) : (
						ordered.map((e) => (
							<div key={e.id} className="rounded-xl bg-raised border border-edge px-3 py-2.5" data-testid="diagnostic-entry">
								<div className="flex items-center gap-2 flex-wrap">
									<span className={`text-xs font-semibold ${levelColor(e.level)}`}>{t(KIND_LABEL[e.kind])}</span>
									{e.count > 1 && <span className="text-fg-muted text-xs font-mono">×{e.count}</span>}
									<span className="text-fg-muted text-xs font-mono ml-auto">{formatTime(e.ts)}</span>
								</div>
								<div className="text-fg-2 text-sm font-mono break-words whitespace-pre-wrap mt-1">{e.message}</div>
								{e.source && <div className="text-fg-muted text-xs font-mono mt-1 break-words">{e.source}</div>}
								{e.detail && (
									<details className="mt-1.5">
										<summary className="text-fg-3 text-xs cursor-pointer select-none">{t("diagnostics.detail")}</summary>
										<pre className="text-fg-muted text-[0.6875rem] font-mono whitespace-pre-wrap break-words mt-1 max-h-40 overflow-auto">
											{e.detail}
										</pre>
									</details>
								)}
							</div>
						))
					)}
				</div>

				{/* Footer */}
				<div className="flex flex-wrap items-center gap-2 p-4 border-t border-edge">
					<button
						type="button"
						onClick={handleCopy}
						disabled={ordered.length === 0}
						className="px-3 py-2 text-sm rounded-lg text-fg-2 border border-edge hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{copied ? t("diagnostics.copied") : t("diagnostics.copyAll")}
					</button>
					<button
						type="button"
						onClick={() => clearDiagnostics()}
						disabled={ordered.length === 0}
						className="px-3 py-2 text-sm rounded-lg text-danger hover:bg-danger/10 border border-danger/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{t("diagnostics.clear")}
					</button>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="px-3 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors ml-auto"
					>
						{t("diagnostics.reload")}
					</button>
				</div>
			</div>
		</div>
	);
}
