import type { UpdateChangelog } from "../../shared/types";
import { parseDisplayVersion } from "../../shared/update-channel";
import { useT } from "../i18n";
import CanaryBadge from "./CanaryBadge";
import { UpdateReadyIcon } from "./HeaderIcons";

/** Static placeholder countdown shown in the simulator (no real timer runs). */
const PREVIEW_COUNTDOWN_SECONDS = 205;

interface UpdateWhatsNewProps {
	version: string;
	changelog?: UpdateChangelog | null;
	onSeeAllChanges: () => void;
	/** Extra classes for the root (e.g. top margin when embedded in the toast). */
	className?: string;
}

/**
 * The "what's new" section — version-scoped feature list + a "+N more · M fixes"
 * rollup + a link to the full Changelog screen. Shared by the header dropdown
 * popover and the auto-shown update toast so both surface the same preview.
 * Renders nothing when the incoming update carries no feature titles.
 */
export function UpdateWhatsNew({ version, changelog, onSeeAllChanges, className }: UpdateWhatsNewProps) {
	const t = useT();
	// IN vs SINCE, AND ON CANARY ONLY "SINCE" IS TRUE. The payload is the changelog window
	// after the previous release tag (scripts/build-update-changelog.ts), so on a tagged
	// stable release those entries ARE the release. On canary the same list is everything
	// that has landed on main since — "what's new in v1.42.3" names the one version these
	// features are provably NOT in.
	const { core, channel } = parseDisplayVersion(version);
	if (!changelog || changelog.features.length === 0) return null;
	const moreFeat = Math.max(0, changelog.featureCount - changelog.features.length);
	const parts: string[] = [];
	if (moreFeat > 0) parts.push(t.plural("update.moreFeatures", moreFeat));
	if (changelog.fixCount > 0) parts.push(t.plural("update.fixCount", changelog.fixCount));
	return (
		<div className={`border-t border-edge pt-2.5 space-y-1.5${className ? ` ${className}` : ""}`}>
			<div className="text-fg-3 text-dense font-semibold uppercase tracking-wider">
				{t(channel === "canary" ? "update.whatsNewSinceVersion" : "update.whatsNewVersion", { version: core })}
			</div>
			<div className="space-y-1">
				{changelog.features.map((feature, i) => (
					<div key={i} className="flex items-start gap-1.5 min-w-0">
						<span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
						<span className="text-fg text-xs leading-snug truncate">{feature}</span>
					</div>
				))}
			</div>
			{parts.length > 0 && <div className="text-fg-muted text-micro">{parts.join(" · ")}</div>}
			<button
				type="button"
				onClick={onSeeAllChanges}
				className="text-accent text-xs font-medium hover:underline cursor-pointer"
			>
				{t("update.seeAllChanges")} →
			</button>
		</div>
	);
}

interface UpdateReadyPopoverProps {
	version: string;
	changelog?: UpdateChangelog | null;
	restarting: boolean;
	/**
	 * Tasks in the `in-progress` column right now. A WARNING, never a gate: the
	 * restart does not kill an agent (tmux sessions are detached and lifecycles are
	 * rehydrated on boot), so the button stays live — this only lets someone decide
	 * to wait a minute. 0 renders nothing.
	 */
	tasksInProgress?: number;
	/**
	 * True on a headless `dev3 remote` box, where the restart hands the live
	 * Cloudflare tunnel and the port to the new build — so the public URL and this
	 * browser session survive it. Worth saying, because "restart" on a phone
	 * otherwise reads as "lose the link I am holding".
	 */
	keepsRemoteLink?: boolean;
	onRestart: () => void;
	onSeeAllChanges: () => void;
	/** Preview (simulator) mode: disable the restart button so it never quits the app. */
	preview?: boolean;
}

/**
 * The update-ready popover panel body — version header, features-first "what's
 * new" window, and the Restart button. Shared by the header dropdown
 * (`GlobalHeader`) and the dev-only simulator so both render identically. Owns
 * the panel box; callers own positioning (dropdown absolute vs modal center).
 */
export default function UpdateReadyPopover({
	version,
	changelog,
	restarting,
	tasksInProgress = 0,
	keepsRemoteLink = false,
	onRestart,
	onSeeAllChanges,
	preview = false,
}: UpdateReadyPopoverProps) {
	const t = useT();
	// WHICH BUILD IS BEING OFFERED IS READ OFF THE VERSION STRING, not off local state.
	// During a channel crossing the local channel is the one being LEFT, so it answers the
	// wrong question; the `+canary.<sha>` suffix in the published manifest is the only thing
	// that describes the build on offer. A manifest without one renders exactly as before.
	const { core, channel, sha } = parseDisplayVersion(version);
	return (
		<div className="w-72 bg-overlay border border-edge rounded-xl shadow-2xl p-4 space-y-3">
			<div className="flex items-center gap-2">
				<UpdateReadyIcon className="w-5 h-5 text-accent flex-shrink-0" />
				<div>
					<div className="text-fg text-sm font-semibold">
						{t("update.readyTitle", { version: core })}
						{channel === "canary" && sha && (
							<>
								{" "}
								<CanaryBadge sha={sha} fullVersion={version} />
							</>
						)}
					</div>
					<div className="text-fg-3 text-xs mt-0.5">{t("update.sessionsNote")}</div>
				</div>
			</div>
			<UpdateWhatsNew version={version} changelog={changelog} onSeeAllChanges={onSeeAllChanges} />
			{keepsRemoteLink && (
				<p className="text-fg-3 text-xs">{t("update.remoteLinkSurvives")}</p>
			)}
			{tasksInProgress > 0 && (
				<p className="text-fg-2 text-xs flex items-start gap-1.5">
					<span aria-hidden="true">⚠️</span>
					<span>{t.plural("update.tasksInProgressWarning", tasksInProgress)}</span>
				</p>
			)}
			{preview ? (
				// Preview mimics the auto-shown toast layout (restart-with-countdown +
				// Postpone) so the simulator looks like the real update prompt. The
				// countdown is a static placeholder — no real timer, both disabled.
				<div className="flex gap-2">
					<button
						disabled
						className="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-accent-fill text-white transition-colors disabled:opacity-50"
					>
						{t("update.restartCountdown", { seconds: String(PREVIEW_COUNTDOWN_SECONDS) })}
					</button>
					<button
						disabled
						className="px-3 py-2 text-sm font-medium rounded-lg bg-raised text-fg border border-edge transition-colors disabled:opacity-50"
					>
						{t("update.postponeBtn")}
					</button>
				</div>
			) : (
				<button
					onClick={onRestart}
					disabled={restarting}
					className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors disabled:opacity-50"
				>
					{restarting ? t("update.restarting") : t("update.restartBtn")}
				</button>
			)}
		</div>
	);
}
