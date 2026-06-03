/**
 * Console banner + QR code renderer for `dev3 remote` headless mode.
 *
 * Prints an ASCII QR code (via `qrcode` lib) with the access URL and user-facing
 * tips (SSH port-forward template, --tunnel hint). Re-generates the QR every
 * 25s to stay within the 30s JWT TTL — same schedule as the GUI modal in
 * `src/mainview/App.tsx:443-462`.
 *
 * The refresh halts as soon as a client successfully redeems the QR token
 * (push message `qrTokenConsumed`), mirroring the GUI behavior.
 */

import QRCode from "qrcode";
import { networkInterfaces } from "node:os";
import { createLogger } from "./logger";
import { tunnelManager } from "./cloudflare-tunnel";

const log = createLogger("remote-console");

const REFRESH_INTERVAL_MS = 25_000; // QR TTL is 30s; refresh with 5s headroom

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let qrConsumed = false;

// ── LAN IP discovery ──────────────────────────────────────────────

function getLocalIps(): string[] {
	const out: string[] = [];
	const ifaces = networkInterfaces();
	for (const name of Object.keys(ifaces)) {
		for (const addr of ifaces[name] ?? []) {
			if (addr.family === "IPv4" && !addr.internal) {
				out.push(addr.address);
			}
		}
	}
	return out;
}

// ── Public API ────────────────────────────────────────────────────

interface BannerOptions {
	port: number;
	tunnelUrl: string | null;
	tunnelRequested: boolean;
	accessUrl: string;
	/** Set when `--static-code=<value>` is in effect. Disables QR refresh + URL caveat. */
	staticCode?: string | null;
}

/**
 * Print the initial headless banner with QR, URL, and connection tips.
 * Call once at startup, after the remote-access server is listening.
 */
export async function renderHeadlessBanner(opts: BannerOptions): Promise<void> {
	const { port, tunnelUrl, tunnelRequested, accessUrl, staticCode } = opts;

	// Terminal-rendered QR. `small: true` halves the vertical size by using
	// half-blocks (▀/▄) — stays readable by phone cameras.
	const qrAscii = await QRCode.toString(accessUrl, { type: "terminal", small: true });

	console.log("");
	console.log("╔════════════════════════════════════════════════════════════════╗");
	console.log("║  dev3 remote — headless mode                                   ║");
	console.log("╚════════════════════════════════════════════════════════════════╝");
	console.log("");
	console.log(qrAscii);
	if (staticCode) {
		console.log("  URL (static code — no rotation, dev only):");
	} else {
		console.log("  URL (includes one-time QR token, regenerated every 25s):");
	}
	console.log(`  ${accessUrl}`);
	if (staticCode) {
		console.log("");
		console.log(`  Static access code: ${staticCode}`);
		console.log("  ⚠ Replay protection is disabled — do NOT expose on the public internet.");
	}
	console.log("");

	printConnectionTips({ port, tunnelUrl, tunnelRequested });
}

/**
 * Start the auto-refresh timer that regenerates the QR every 25s and reprints
 * just the URL line (we do NOT reprint the QR — it would clobber scrollback).
 * The QR image itself stays valid for 30s from when it was last printed;
 * users who want a fresh visual QR can rerun the command.
 *
 * The timer stops automatically when `markQrConsumed()` is called.
 */
export function startQrAutoRefresh(urlFactory: () => Promise<string>): void {
	if (refreshTimer) return;
	refreshTimer = setInterval(async () => {
		if (qrConsumed) {
			stopQrAutoRefresh();
			return;
		}
		try {
			const fresh = await urlFactory();
			const qrAscii = await QRCode.toString(fresh, { type: "terminal", small: true });
			console.log("");
			console.log("── QR refreshed ──────────────────────────────────────────────");
			console.log(qrAscii);
			console.log(`  URL: ${fresh}`);
			console.log("");
		} catch (err) {
			log.error("QR refresh failed", { error: String(err) });
		}
	}, REFRESH_INTERVAL_MS);
}

export function stopQrAutoRefresh(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
}

/**
 * Called by the push-message wiring when a browser successfully exchanges a
 * QR token for a session. Stops the refresh loop — no point regenerating QRs
 * once someone's connected.
 */
export function markQrConsumed(): void {
	if (qrConsumed) return;
	qrConsumed = true;
	console.log("");
	console.log("✓ Client connected via QR — auto-refresh paused.");
	console.log("  (Rerun `dev3 remote` for a fresh QR if another device needs to join.)");
	console.log("");
	stopQrAutoRefresh();
}

// ── Connection tips ───────────────────────────────────────────────

interface TipsOptions {
	port: number;
	tunnelUrl: string | null;
	tunnelRequested: boolean;
}

function printConnectionTips(opts: TipsOptions): void {
	const { port, tunnelUrl, tunnelRequested } = opts;
	const ips = getLocalIps();
	const whoami = process.env.USER || "<you>";

	console.log("  How to connect:");
	console.log("");

	if (tunnelUrl) {
		console.log("    ① Public Cloudflare tunnel (works from anywhere):");
		console.log(`         ${tunnelUrl}`);
		console.log("       — scan the QR above, or paste the URL into a browser.");
		console.log("");
	} else if (tunnelRequested) {
		console.log("    ① Public tunnel was requested but failed — falling back to local.");
		console.log("");
	}

	if (ips.length > 0) {
		console.log("    ② Same LAN — scan the QR from a device on your network.");
		console.log(`       LAN IPs: ${ips.join(", ")}`);
		console.log("");
	} else {
		console.log("    ② (no LAN interface detected — skip the QR unless you tunnel)");
		console.log("");
	}

	console.log("    ③ SSH port-forward from your laptop (recommended, no public exposure):");
	console.log(`         ssh -L ${port}:localhost:${port} ${whoami}@<this-server-host>`);
	console.log(`       then open http://localhost:${port}/ in your laptop's browser.`);
	console.log("       (The QR token in the URL above is single-use — the browser");
	console.log("        will exchange it for a session cookie on first load.)");
	console.log("");

	if (!tunnelUrl && !tunnelRequested) {
		console.log("    ④ Need a public URL? Rerun with --tunnel to expose via");
		console.log("       Cloudflare Tunnel (trycloudflare.com).");
		console.log("");
	}

	printExposedPortsBlock(ips);

	console.log("  Press Ctrl-C to stop.");
	console.log("");
}

/**
 * Print a section listing every dev-server port that's been exposed (either
 * via per-port quick tunnels or as part of a shared tunnel). Refreshed on
 * `exposedPortsChanged` via `printExposedPortsLive()` so the user sees URLs
 * the moment `--expose-ports` or the GUI brings them up.
 */
function printExposedPortsBlock(localIps: string[]): void {
	const taskPort = tunnelManager.list({ kind: "task-port" });
	const taskShared = tunnelManager.list({ kind: "task-shared" });
	if (taskPort.length === 0 && taskShared.length === 0) return;

	const whoami = process.env.USER || "<you>";
	const firstLan = localIps[0] ?? "<lan-ip>";

	console.log("  ▼ Exposed dev-server ports:");
	console.log("");
	for (const entry of taskPort) {
		const port = entry.targetPort;
		console.log(`    Port ${port}${entry.taskId ? `  (task ${entry.taskId.slice(0, 8)})` : ""}:`);
		if (entry.url) console.log(`       🌐 Public:    ${entry.url}`);
		console.log(`       🏠 LAN:       http://${firstLan}:${port}`);
		console.log(`       💻 Localhost: http://localhost:${port}  (after ssh -L)`);
		console.log(`       🔐 SSH:       ssh -L ${port}:localhost:${port} ${whoami}@<host>`);
		console.log("");
	}
	for (const entry of taskShared) {
		console.log(`    Shared tunnel (task ${entry.taskId?.slice(0, 8) ?? "?"}) → ports ${entry.ports.join(", ")}:`);
		if (entry.url) {
			for (const p of entry.ports) {
				console.log(`       🌐 Port ${p}:  ${entry.url}/p/${entry.subToken}/${p}/`);
			}
		}
		console.log("");
	}
}

/**
 * Reprint a fresh "Exposed dev-server ports" block. Called on the
 * `exposedPortsChanged` push event so the headless console always shows the
 * current set of public URLs without forcing the user to scroll up.
 */
export function printExposedPortsLive(): void {
	const ips = getLocalIps();
	console.log("");
	console.log("── Exposed ports updated ─────────────────────────────────────");
	printExposedPortsBlock(ips);
}
