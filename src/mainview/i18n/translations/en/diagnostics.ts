const diagnostics = {
	// ── Bootstrap / loading screen ──
	"boot.phase.connecting": "Connecting to your computer…",
	"boot.phase.authenticating": "Authenticating…",
	"boot.phase.reconnecting": "Reconnecting…",
	"boot.phase.checking": "Checking system…",
	"boot.phase.loading": "Loading your projects…",
	"boot.stuck.title": "This is taking longer than usual",
	"boot.stuck.connecting":
		"dev-3.0 can't reach your computer. Check that the remote server is still running and your network is stable.",
	"boot.stuck.generic": "Startup seems stuck. Retry, or reload the app.",
	"boot.connection": "Connection",
	"boot.lastError": "Last error",
	"boot.retry": "Retry",
	"boot.reload": "Reload",
	"boot.showDetails": "Show details",

	// ── Diagnostics panel ──
	"diagnostics.title": "Diagnostics",
	"diagnostics.subtitle": "Errors captured in this session",
	"diagnostics.empty": "No issues captured. Everything looks healthy.",
	"diagnostics.copyAll": "Copy all",
	"diagnostics.copied": "Copied",
	"diagnostics.clear": "Clear",
	"diagnostics.close": "Close",
	"diagnostics.reload": "Reload app",
	"diagnostics.detail": "Details",

	// Kind labels
	"diagnostics.kind.error": "Error",
	"diagnostics.kind.rejection": "Unhandled rejection",
	"diagnostics.kind.react": "Render crash",
	"diagnostics.kind.rpc": "Connection",

	// Connection-state labels
	"diagnostics.conn.connected": "Connected",
	"diagnostics.conn.connecting": "Connecting",
	"diagnostics.conn.authenticating": "Authenticating",
	"diagnostics.conn.reconnecting": "Reconnecting",
	"diagnostics.conn.closed": "Disconnected",
	"diagnostics.conn.authFailed": "Authentication failed",

	// Floating indicator (remote only, shown when errors exist)
	"diagnostics.indicatorLabel": "Show diagnostics",
	"diagnostics.issues_one": "{count} issue",
	"diagnostics.issues_other": "{count} issues",
} as const;

export default diagnostics;
