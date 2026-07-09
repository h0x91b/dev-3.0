import { useT } from "../i18n";
import { isRemote } from "../utils/platform";
import { useDiagnosticsErrorCount } from "../hooks/useDiagnostics";
import { DIAGNOSTICS_OPEN_EVENT } from "../diagnostics";

/**
 * Floating diagnostics pill — the always-available (but *earned*) entry to the
 * diagnostics panel.
 *
 * Renders ONLY in remote mode AND only once at least one error was captured, so
 * it adds zero chrome to the happy path (no toolbar-button creep) and stays out
 * of the Electrobun desktop shell, which already has devtools + "Open logs". On
 * a phone browser — where there is no console — this is the one visible signal
 * that something went wrong and a way to see/copy it.
 */
export default function DiagnosticsIndicator() {
	const t = useT();
	const count = useDiagnosticsErrorCount();

	if (!isRemote() || count === 0) return null;

	return (
		<button
			type="button"
			onClick={() => window.dispatchEvent(new CustomEvent(DIAGNOSTICS_OPEN_EVENT))}
			aria-label={t("diagnostics.indicatorLabel")}
			data-testid="diagnostics-indicator"
			className="fixed z-[55] flex items-center gap-2 pl-2.5 pr-3 py-2 rounded-full bg-danger/15 border border-danger/40 text-danger shadow-lg backdrop-blur-sm hover:bg-danger/25 transition-colors"
			style={{
				bottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
				left: "calc(env(safe-area-inset-left, 0px) + 0.75rem)",
			}}
		>
			<span className="text-lg leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
				{"\uf188"}
			</span>
			<span className="text-xs font-semibold whitespace-nowrap">{t.plural("diagnostics.issues", count)}</span>
		</button>
	);
}
