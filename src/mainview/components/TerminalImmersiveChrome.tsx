import { useT } from "../i18n";

interface TerminalImmersiveChromeProps {
	onExit: () => void;
}

/** The only app-owned chrome rendered while a task terminal is immersive. */
export default function TerminalImmersiveChrome({ onExit }: TerminalImmersiveChromeProps) {
	const t = useT();

	return (
		<div
			className="h-9 min-h-9 flex-shrink-0 flex items-center justify-between gap-3 border-b border-warning/40 bg-warning/10 px-3"
			data-testid="terminal-immersive-chrome"
		>
			<span className="text-warning text-xs font-semibold tracking-wide" aria-label="dev3">dev3</span>
			<button
				type="button"
				onClick={onExit}
				className="min-w-[12rem] rounded-md bg-warning px-6 py-1 text-xs font-semibold text-hint-fg transition-colors hover:bg-warning/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
				aria-label={t("infoPanel.exitFullScreen")}
			>
				{t("infoPanel.exitFullScreen")}
			</button>
		</div>
	);
}
