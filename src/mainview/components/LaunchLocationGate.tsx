import { useState } from "react";
import type { LaunchLocationIssue } from "../../shared/types";
import { useT } from "../i18n";
import { api } from "../rpc";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useReducedMotion } from "../utils/useReducedMotion";

type Phase = { kind: "idle" } | { kind: "moving" } | { kind: "failed"; error: string };

/**
 * Blocking launch gate: dev3 runs from a place it can never update itself (a mounted DMG,
 * an App Translocation copy, a read-only folder). No dismiss path on purpose — the user who
 * hit this ignored a stuck update for days. See
 * decisions/2026/11/04/block-launch-from-read-only-location.md.
 */
export default function LaunchLocationGate({ issue }: { issue: NonNullable<LaunchLocationIssue> }) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const reducedMotion = useReducedMotion();
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const fromInstaller = issue.kind !== "read-only";

	const move = () => {
		setPhase({ kind: "moving" });
		api.request
			.moveAppToApplications()
			.then((res) => {
				// Success: the app quits on its own a moment later; stay in "moving".
				if (!res.ok) setPhase({ kind: "failed", error: res.error });
			})
			.catch((err) => setPhase({ kind: "failed", error: String(err) }));
	};

	const quit = () => {
		void api.request.quitApp();
	};

	const moving = phase.kind === "moving";

	return (
		<div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60" data-testid="launch-location-gate">
			<div
				ref={trapRef}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="launch-location-title"
				aria-describedby="launch-location-body"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[34rem] max-w-[calc(100vw-2rem)] p-6 space-y-3 outline-none"
			>
				<div className="flex items-center gap-3">
					<span
						aria-hidden="true"
						className="text-warning-strong text-2xl leading-none"
						style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
					>
						{"\uf071"}
					</span>
					<h2 id="launch-location-title" className="text-fg text-lg font-semibold">
						{fromInstaller ? t("launchLocation.titleInstaller") : t("launchLocation.titleReadOnly")}
					</h2>
				</div>

				<p id="launch-location-body" className="text-fg-2 text-sm">
					{fromInstaller ? t("launchLocation.bodyInstaller") : t("launchLocation.bodyReadOnly")}
				</p>
				<p className="text-fg-3 text-sm">
					{t("launchLocation.moveHint")}{" "}
					<code className="streamer-private font-mono text-xs text-fg-2 break-all">{issue.destination}</code>
				</p>

				{phase.kind === "failed" && (
					<div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 space-y-1">
						<p className="text-danger text-sm">{t("launchLocation.failed", { error: phase.error })}</p>
						<p className="text-fg-2 text-sm">{t("launchLocation.manual")}</p>
					</div>
				)}

				<p className="text-fg-muted text-xs">{t("launchLocation.dataSafe")}</p>

				<div className="flex justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={quit}
						disabled={moving}
						className="px-4 py-2 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-overlay-hover transition-colors disabled:opacity-50"
					>
						{t("launchLocation.quitBtn")}
					</button>
					<button
						type="button"
						onClick={move}
						disabled={moving}
						autoFocus
						aria-busy={moving}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors active:scale-[0.96] disabled:opacity-70"
					>
						{moving && (
							<span
								aria-hidden="true"
								className={`h-3 w-3 rounded-full border-2 border-white/30 border-t-white${reducedMotion ? "" : " animate-spin"}`}
							/>
						)}
						{moving
							? t("launchLocation.movingBtn")
							: phase.kind === "failed"
								? t("launchLocation.retryBtn")
								: t("launchLocation.moveBtn")}
					</button>
				</div>
			</div>
		</div>
	);
}
