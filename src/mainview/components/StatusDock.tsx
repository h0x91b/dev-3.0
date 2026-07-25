import ConnectionStatusPill from "./ConnectionStatusPill";
import DiagnosticsIndicator from "./DiagnosticsIndicator";

/**
 * Bottom-left dock for the remote-only floating status pills (connection state,
 * diagnostics). One owner of the corner so two conditional pills can never
 * overlap, and safe-area insets are declared once.
 */
export default function StatusDock() {
	return (
		<div
			className="fixed z-[55] flex flex-col items-start gap-2 pointer-events-none"
			style={{
				bottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
				left: "calc(env(safe-area-inset-left, 0px) + 0.75rem)",
			}}
		>
			<ConnectionStatusPill />
			<DiagnosticsIndicator />
		</div>
	);
}
