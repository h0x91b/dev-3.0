const panes = {
	"panes.layoutLabel": "Layout",
	"panes.chooseLayout": "Choose pane layout",
	"panes.unzoom": "Unzoom",
	"panes.actionFailed": "Pane action failed: {error}",
	"panes.layoutNeedsTwoPanes": "Need at least 2 panes to cycle layouts",
	"panes.nativeHintsTitle": "Terminal Shortcuts",
	"panes.nativeNoPrefixKeys": "No ⌃B prefix — pane actions use the toolbar above",
	"panes.nativeWindowsUnavailable": "Windows are tmux-only (not available on native tasks)",
	"panes.paneLabel": "Pane {index}",
	"panes.exited": "Pane exited",
	"panes.exitedClose": "Close pane",
	"panes.hostGone": "Terminal host is gone — use the recovery controls below",
	"panes.unsupportedOnBackend": "Not supported on this backend",
	"panes.resizeDivider": "Resize the boundary between {first} and {second}",
	"panes.resizeDividerValue": "{percent}% for the first pane",
} as const;

export default panes;
