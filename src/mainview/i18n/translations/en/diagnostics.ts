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
	// Floating connection pill (remote only, shown while the transport is unhealthy)
	"conn.pill.retry": "Tap to retry",
	"conn.pill.retryAria": "Connection lost — retry now",
	"conn.pill.restored": "Back online",
	// ── Remote connection quality (header readout) ──
	"connQuality.title": "Connection quality",
	"connQuality.definition": "Round trip of one request through the same connection the app uses.",
	"connQuality.ariaLabel": "Connection round trip {ms} ms — open the breakdown",
	"connQuality.median": "Typical round trip",
	"connQuality.p95": "Slowest 1 in 20",
	"connQuality.jitter": "Jitter",
	"connQuality.ours": "Spent on this computer",
	"connQuality.network": "Spent on the network",
	"connQuality.path": "Route",
	"connQuality.pathTunnel": "Cloudflare tunnel",
	"connQuality.pathLan": "Direct, local network",
	"connQuality.pathLocal": "Same machine",
	"connQuality.samples": "Samples",
	"connQuality.samplesWithLoss": "{count} ({lost} lost)",
	"connQuality.host": "Address",
	"connQuality.compareHint": "This is the whole loop. To blame the tunnel, open the direct local-network URL and compare the same number.",
} as const;

export default diagnostics;
