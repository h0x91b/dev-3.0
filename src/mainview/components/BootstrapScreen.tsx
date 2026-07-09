import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";
import { getDiagnostics } from "../diagnostics";

export type BootPhase = "connecting" | "authenticating" | "reconnecting" | "checking" | "loading";

const PHASE_LABEL: Record<BootPhase, TranslationKey> = {
	connecting: "boot.phase.connecting",
	authenticating: "boot.phase.authenticating",
	reconnecting: "boot.phase.reconnecting",
	checking: "boot.phase.checking",
	loading: "boot.phase.loading",
};

const CONNECTION_PHASES: ReadonlySet<BootPhase> = new Set(["connecting", "authenticating", "reconnecting"]);

/** How long a single phase may run before we surface the "stuck" panel. */
const DEFAULT_STUCK_AFTER_MS = 12_000;

/**
 * Bootstrap / loading screen. Replaces the two bare "Loading…" spinners that
 * used to spin silently (up to the 120s RPC timeout) whenever a remote/mobile
 * connection hung. It names the current phase and, after a timeout, flips to an
 * actionable panel: the likely cause, the last captured error, and Retry/Reload —
 * so the user is never stuck staring at a spinner with no information.
 */
export default function BootstrapScreen({
	phase,
	onRetry,
	stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
}: {
	phase: BootPhase;
	onRetry: () => void;
	stuckAfterMs?: number;
}) {
	const t = useT();
	const [stuck, setStuck] = useState(false);

	// Reset the stuck timer whenever the phase changes — a phase transition is
	// progress, so the countdown to "something's wrong" starts over.
	useEffect(() => {
		setStuck(false);
		const id = setTimeout(() => setStuck(true), stuckAfterMs);
		return () => clearTimeout(id);
	}, [phase, stuckAfterMs]);

	if (!stuck) {
		return (
			<div className="h-full w-full flex items-center justify-center bg-base p-6">
				<div className="flex items-center gap-3">
					<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
					<span className="text-fg-3 text-sm">{t(PHASE_LABEL[phase])}</span>
				</div>
			</div>
		);
	}

	const isConnection = CONNECTION_PHASES.has(phase);
	const lastError = getDiagnostics()
		.slice()
		.reverse()
		.find((e) => e.level === "error");

	return (
		<div className="h-full w-full flex items-center justify-center bg-base overflow-auto p-4">
			<div className="w-full max-w-md bg-raised border border-edge rounded-2xl shadow-2xl p-6 space-y-4">
				<div className="flex items-center gap-3">
					<span
						className="text-warning text-2xl leading-none flex-shrink-0"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\uf071"}
					</span>
					<h1 className="text-fg text-base font-semibold leading-tight">{t("boot.stuck.title")}</h1>
				</div>

				<p className="text-fg-2 text-sm leading-relaxed">
					{isConnection ? t("boot.stuck.connecting") : t("boot.stuck.generic")}
				</p>

				<div className="rounded-xl bg-elevated border border-edge px-3 py-2 flex items-center gap-2">
					<span className="text-fg-muted text-xs">{t("boot.connection")}</span>
					<span className="text-fg-2 text-xs font-medium ml-auto">{t(PHASE_LABEL[phase])}</span>
				</div>

				{lastError && (
					<div className="rounded-xl bg-elevated border border-edge px-3 py-2.5">
						<div className="text-fg-muted text-xs mb-1">{t("boot.lastError")}</div>
						<div className="text-danger text-xs font-mono break-words whitespace-pre-wrap">{lastError.message}</div>
					</div>
				)}

				<div className="flex flex-wrap justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="px-4 py-2 text-sm rounded-lg text-fg-2 border border-edge hover:text-fg hover:bg-elevated transition-colors"
					>
						{t("boot.reload")}
					</button>
					<button
						type="button"
						onClick={onRetry}
						className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
					>
						{t("boot.retry")}
					</button>
				</div>
			</div>
		</div>
	);
}
