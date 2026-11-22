// Uniform full-width row used by the narrow-viewport (mobile) actions sheet.
// The mobile sheet is a curated read/trigger surface — a clean list of rows, not
// the dense desktop toolbar (UX bible §12.3/§12.6). The touch-target floor comes
// from the `.touch-actions` group wrapper around the list.
export const SHEET_ROW_CLASS =
	"flex w-full items-center gap-3 rounded-xl border border-edge bg-raised px-4 py-2.5 text-left text-fg transition-colors hover:bg-raised-hover active:bg-elevated";
