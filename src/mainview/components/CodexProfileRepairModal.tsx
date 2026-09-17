import { useCallback, useState } from "react";
import { useT } from "../i18n";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";

interface CodexProfileRepairModalProps {
	/** The file the repair edits — named on screen, never edited without a click. */
	configPath: string;
	onRepair: () => Promise<boolean>;
	onLater: () => void;
	onNever: () => void;
}

/**
 * Startup offer to undo damage dev3 did to somebody else's tool: an older dev3
 * wrote a permission profile into `~/.codex/config.toml` narrower than Codex's
 * own default, which stops standalone Codex from starting a session on a
 * Homebrew install. dev3 will not repair that on its own — the profile is
 * indistinguishable from a hand-written one — so it asks, states exactly which
 * line it would change, and takes "never" for an answer permanently.
 */
export default function CodexProfileRepairModal({ configPath, onRepair, onLater, onNever }: CodexProfileRepairModalProps) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	useEscapeKey(onLater);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	const handleRepair = useCallback(() => {
		setBusy(true);
		setFailed(false);
		void onRepair()
			.then((ok) => {
				if (!ok) setFailed(true);
			})
			.finally(() => setBusy(false));
	}, [onRepair]);

	return (
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onLater();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="codex-repair-title"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] max-w-[calc(100vw-2rem)] p-6 space-y-3 outline-none"
			>
				<div className="flex items-center gap-3">
					<span
						className="text-warning-strong text-2xl leading-none"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{""}
					</span>
					<h2 id="codex-repair-title" className="text-fg text-lg font-semibold">
						{t("codexRepair.title")}
					</h2>
				</div>

				<p className="text-fg-2 text-sm">{t("codexRepair.body")}</p>
				{/* The path names the user's home directory, so it masks in streamer mode. */}
				<p className="text-fg-3 text-sm streamer-private">{t("codexRepair.blastRadius", { path: configPath })}</p>

				<code className="block bg-base border border-edge rounded-lg px-3 py-2 text-xs font-mono text-fg-2 break-all select-all">
					{'":minimal" = "read"  →  ":root" = "read"'}
				</code>

				<p className="text-fg-muted text-xs">{t("codexRepair.scope")}</p>
				{failed && <p className="text-danger text-xs">{t("codexRepair.failed")}</p>}

				<div className="flex items-center justify-between gap-2 pt-1">
					<button
						type="button"
						onClick={onNever}
						className="px-2 py-2 text-xs rounded-lg text-fg-muted hover:text-fg-2 transition-colors"
					>
						{t("codexRepair.neverBtn")}
					</button>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={onLater}
							className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-elevated transition-colors"
						>
							{t("codexRepair.laterBtn")}
						</button>
						<button
							type="button"
							onClick={handleRepair}
							disabled={busy}
							className="px-4 py-2 text-sm rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors disabled:opacity-60"
						>
							{busy ? t("codexRepair.repairingBtn") : t("codexRepair.repairBtn")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
