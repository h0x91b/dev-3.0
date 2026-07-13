import { useT } from "../i18n";

interface TerminalImmersiveChromeProps {
	onExit: () => void;
}

/** The only app-owned chrome rendered while a task terminal is immersive. */
export default function TerminalImmersiveChrome({ onExit }: TerminalImmersiveChromeProps) {
	const t = useT();

	return (
		<div
			className="h-11 min-h-11 md:h-7 md:min-h-7 flex-shrink-0 flex items-center justify-between gap-2 border-b border-edge bg-raised px-2.5"
			data-testid="terminal-immersive-chrome"
		>
			<span className="text-fg-3 text-[0.625rem] font-semibold tracking-wide" aria-label="dev3">dev3</span>
			<button
				type="button"
				onClick={onExit}
				className="min-w-[12rem] h-11 min-h-11 md:h-6 md:min-h-6 rounded-md border border-edge-active bg-elevated px-4 text-xs font-medium text-fg-2 transition-colors hover:bg-elevated-hover hover:text-fg focus-visible:outline-none"
				aria-label={t("infoPanel.exitFullScreen")}
			>
				{t("infoPanel.exitFullScreen")}
			</button>
		</div>
	);
}
