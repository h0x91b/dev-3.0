import type { UpdateChangelog } from "../../shared/types";
import { useT } from "../i18n";
import { UpdateReadyIcon } from "./HeaderIcons";

/** Static placeholder countdown shown in the simulator (no real timer runs). */
const PREVIEW_COUNTDOWN_SECONDS = 205;

interface UpdateReadyPopoverProps {
	version: string;
	changelog?: UpdateChangelog | null;
	restarting: boolean;
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
	onRestart,
	onSeeAllChanges,
	preview = false,
}: UpdateReadyPopoverProps) {
	const t = useT();
	return (
		<div className="w-72 bg-overlay border border-edge rounded-xl shadow-2xl p-4 space-y-3">
			<div className="flex items-center gap-2">
				<UpdateReadyIcon className="w-5 h-5 text-accent flex-shrink-0" />
				<div>
					<div className="text-fg text-sm font-semibold">{t("update.readyTitle", { version })}</div>
					<div className="text-fg-3 text-xs mt-0.5">{t("update.sessionsNote")}</div>
				</div>
			</div>
			{changelog && changelog.features.length > 0 && (
				<div className="border-t border-edge pt-2.5 space-y-1.5">
					<div className="text-fg-3 text-[0.625rem] font-semibold uppercase tracking-wider">
						{t("update.whatsNewVersion", { version })}
					</div>
					<div className="space-y-1">
						{changelog.features.map((feature, i) => (
							<div key={i} className="flex items-start gap-1.5 min-w-0">
								<span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
								<span className="text-fg text-xs leading-snug truncate">{feature}</span>
							</div>
						))}
					</div>
					{(() => {
						const moreFeat = Math.max(0, changelog.featureCount - changelog.features.length);
						const parts: string[] = [];
						if (moreFeat > 0) parts.push(t.plural("update.moreFeatures", moreFeat));
						if (changelog.fixCount > 0) parts.push(t.plural("update.fixCount", changelog.fixCount));
						return parts.length > 0 ? <div className="text-fg-muted text-[0.6875rem]">{parts.join(" · ")}</div> : null;
					})()}
					<button
						type="button"
						onClick={onSeeAllChanges}
						className="text-accent text-xs font-medium hover:underline cursor-pointer"
					>
						{t("update.seeAllChanges")} →
					</button>
				</div>
			)}
			{preview ? (
				// Preview mimics the auto-shown toast layout (restart-with-countdown +
				// Postpone) so the simulator looks like the real update prompt. The
				// countdown is a static placeholder — no real timer, both disabled.
				<div className="flex gap-2">
					<button
						disabled
						className="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-accent text-white transition-colors disabled:opacity-50"
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
					className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
				>
					{restarting ? t("update.restarting") : t("update.restartBtn")}
				</button>
			)}
		</div>
	);
}
