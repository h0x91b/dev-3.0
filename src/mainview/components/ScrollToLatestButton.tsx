import { useT } from "../i18n";

interface ScrollToLatestButtonProps {
	onClick: () => void;
}

/**
 * Round floating button over the terminal canvas — the touch path back to the
 * live tail. Rendered by the host only while the pane is scrolled into history
 * (bible §10 "return to live output from scrollback"), so it never rests as
 * permanent chrome. Sits above the tmux status line, inside the safe area.
 */
function ScrollToLatestButton({ onClick }: ScrollToLatestButtonProps) {
	const t = useT();
	return (
		<button
			type="button"
			onMouseDown={(e) => e.preventDefault()}
			onClick={onClick}
			aria-label={t("terminal.scrollToLatest")}
			data-testid="scroll-to-latest"
			className="absolute right-3 bottom-14 z-20 w-12 h-12 rounded-full bg-accent-fill text-white shadow-lg shadow-black/40 flex items-center justify-center transition-transform active:scale-[0.96] hover:bg-accent-fill-hover"
			style={{ marginBottom: "env(safe-area-inset-bottom)" }}
		>
			<svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
				<path d="M12 4v13" />
				<path d="M6 11l6 6 6-6" />
			</svg>
		</button>
	);
}

export default ScrollToLatestButton;
