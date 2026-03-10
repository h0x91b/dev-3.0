import { useState } from "react";
import { useT } from "../i18n";

const GH_WARNING_DISMISSED_KEY = "dev3-gh-warning-dismissed";

interface GhWarningBannerProps {
	notInstalled: boolean;
	onDismiss: () => void;
}

export default function GhWarningBanner({ notInstalled, onDismiss }: GhWarningBannerProps) {
	const t = useT();
	const [dontShowAgain, setDontShowAgain] = useState(false);

	function handleDismiss() {
		if (dontShowAgain) {
			localStorage.setItem(GH_WARNING_DISMISSED_KEY, "true");
		}
		onDismiss();
	}

	const title = notInstalled ? t("ghWarning.titleNotInstalled") : t("ghWarning.titleNotAuthenticated");
	const message = notInstalled ? t("ghWarning.messageNotInstalled") : t("ghWarning.messageNotAuthenticated");

	return (
		<div className="flex items-start gap-3 px-4 py-3 bg-elevated border-b border-edge text-sm">
			<span className="text-[#fbbf24] mt-0.5 shrink-0" aria-hidden="true">⚠</span>
			<div className="flex-1 min-w-0">
				<span className="font-medium text-fg">{title}</span>
				<span className="text-fg-2 ml-1.5">{message}</span>
			</div>
			<div className="flex items-center gap-3 shrink-0">
				<label className="flex items-center gap-1.5 cursor-pointer select-none text-fg-3 hover:text-fg-2 transition-colors">
					<input
						type="checkbox"
						checked={dontShowAgain}
						onChange={(e) => setDontShowAgain(e.target.checked)}
						className="w-3.5 h-3.5 rounded accent-accent"
					/>
					<span>{t("ghWarning.dontShowAgain")}</span>
				</label>
				<button
					onClick={handleDismiss}
					className="px-3 py-1 rounded-md bg-elevated-hover text-fg-2 hover:text-fg transition-colors"
				>
					{t("ghWarning.dismiss")}
				</button>
			</div>
		</div>
	);
}

export function isGhWarningDismissed(): boolean {
	return localStorage.getItem(GH_WARNING_DISMISSED_KEY) === "true";
}
