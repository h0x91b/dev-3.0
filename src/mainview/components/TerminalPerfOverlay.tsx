import { useEffect, useState } from "react";
import { useT } from "../i18n";
import {
	snapshotAllPanes,
	LONG_FRAME_MS,
	type LatencySnapshot,
} from "../terminal-latency";

/**
 * Terminal performance HUD — the read-out for "why does this feel laggy".
 *
 * A **debug surface**, reached only from View → Debug → Terminal Performance —
 * the native menu on desktop, the DOM menu bar in remote mode. No toolbar button,
 * no header slot, no shortcut, and deliberately not in the command palette (no
 * Debug item is): the manifest keeps debug entry points menu-only, and the
 * diagnostics precedent (§5.5) is that a diagnostic entry point is earned, never
 * permanent chrome.
 *
 * **How to read it.** ghostty renders on an unconditional `requestAnimationFrame`
 * loop, so `fps` near 60 only means the loop is healthy — it is NOT smoothness.
 * The three numbers that answer "is scrolling choppy" are `upd` (frames that
 * carried new bytes — how often the picture actually changed), `gap` p95 (did a
 * frame miss its slot) and `long` (how many did, per second).
 *
 * Every metric name here names a code-level thing (`write()`, `render()`, `fps`,
 * `p50`) and stays untranslated on purpose, the same way terminal output does.
 */

/** How often the HUD re-reads the probes. Fast enough to watch, cheap enough to ignore. */
const POLL_MS = 500;

/** Below this the render loop is not keeping up with a 60 Hz display. */
const FPS_WARN = 55;
const FPS_BAD = 40;

type Tone = "ok" | "warn" | "bad";

function toneClass(tone: Tone): string {
	if (tone === "bad") return "text-danger";
	if (tone === "warn") return "text-warning";
	return "text-fg-2";
}

function fpsTone(fps: number): Tone {
	if (fps < FPS_BAD) return "bad";
	if (fps < FPS_WARN) return "warn";
	return "ok";
}

function msTone(ms: number): Tone {
	if (ms > LONG_FRAME_MS * 2) return "bad";
	if (ms > LONG_FRAME_MS) return "warn";
	return "ok";
}

function countTone(n: number): Tone {
	if (n > 10) return "bad";
	if (n > 0) return "warn";
	return "ok";
}

function humanBytes(perSecond: number): string {
	if (perSecond >= 1024 * 1024) return `${(perSecond / (1024 * 1024)).toFixed(1)} MB/s`;
	if (perSecond >= 1024) return `${(perSecond / 1024).toFixed(1)} KB/s`;
	return `${perSecond} B/s`;
}

function Row({ label, value, tone = "ok", hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
	return (
		<div className="flex items-baseline gap-2 leading-tight">
			<span className="w-12 shrink-0 text-fg-muted">{label}</span>
			<span className={`flex-1 tabular-nums ${toneClass(tone)}`}>{value}</span>
			{hint && <span className="text-fg-muted">{hint}</span>}
		</div>
	);
}

function PaneBlock({ paneKey, snap }: { paneKey: string; snap: LatencySnapshot }) {
	const { rates } = snap;
	return (
		<div className="border-t border-edge pt-2 first:border-t-0 first:pt-0">
			<div className="truncate text-fg-3 mb-1" title={paneKey}>{paneKey}</div>
			<Row
				label="fps"
				value={`${rates.fps}`}
				tone={fpsTone(rates.fps)}
				hint={`upd ${rates.updates}/s`}
			/>
			<Row
				label="gap"
				value={`${snap.gap.p50} / ${snap.gap.p95} / ${snap.gap.max}`}
				tone={msTone(snap.gap.p95)}
				hint="ms"
			/>
			<Row
				label="long"
				value={`${rates.longFrames}/s`}
				tone={countTone(rates.longFrames)}
				hint={`>${LONG_FRAME_MS}ms`}
			/>
			<Row
				label="render"
				value={`${snap.frame.p50} / ${snap.frame.p95} / ${snap.frame.max}`}
				tone={msTone(snap.frame.p95)}
				hint="ms"
			/>
			<Row
				label="write"
				value={`${snap.write.p50} / ${snap.write.p95} / ${snap.write.max}`}
				tone={msTone(snap.write.p95)}
				hint="ms"
			/>
			<Row
				label="echo"
				value={snap.echo.count ? `${snap.echo.p50} / ${snap.echo.p95} / ${snap.echo.max}` : "—"}
				tone={msTone(snap.echo.p95)}
				hint={snap.echo.count ? `ms ×${snap.echo.count}` : "type to sample"}
			/>
			<Row
				label="paint"
				value={snap.paint.count ? `${snap.paint.p50} / ${snap.paint.p95} / ${snap.paint.max}` : "—"}
				tone={msTone(snap.paint.p95)}
				hint={snap.paint.count ? `ms ×${snap.paint.count}` : ""}
			/>
			<Row label="pty" value={humanBytes(rates.bytes)} hint={`${rates.messages} msg/s`} />
			<Row
				label="wheel"
				value={`${rates.wheelEvents} ev/s → ${rates.wheelLines} ln/s`}
				tone={snap.wheelBacklog > 0 ? "warn" : "ok"}
				hint={`q${snap.wheelBacklog}`}
			/>
		</div>
	);
}

export default function TerminalPerfOverlay({ onClose }: { onClose: () => void }) {
	const t = useT();
	const [panes, setPanes] = useState<Record<string, LatencySnapshot>>(() => snapshotAllPanes());

	useEffect(() => {
		const timer = setInterval(() => setPanes(snapshotAllPanes()), POLL_MS);
		return () => clearInterval(timer);
	}, []);

	const keys = Object.keys(panes);

	return (
		<div
			data-testid="terminal-perf-overlay"
			className="fixed bottom-4 right-4 z-50 w-72 max-h-[70vh] overflow-auto rounded-lg border border-edge bg-overlay/95 shadow-xl backdrop-blur-sm px-3 py-2 font-mono text-[11px] text-fg-2"
		>
			<div className="flex items-center justify-between gap-2 mb-2">
				<span className="font-semibold text-fg">{t("terminal.perf.title")}</span>
				<button
					type="button"
					onClick={onClose}
					aria-label={t("terminal.perf.close")}
					data-testid="terminal-perf-close"
					className="text-fg-3 hover:text-accent-emphasis px-1 leading-none"
				>
					×
				</button>
			</div>

			{keys.length === 0 ? (
				<p className="text-fg-muted">{t("terminal.perf.noPanes")}</p>
			) : (
				<div className="space-y-2">
					{keys.map((key) => (
						<PaneBlock key={key} paneKey={key} snap={panes[key]} />
					))}
				</div>
			)}

			<p className="mt-2 border-t border-edge pt-2 text-fg-muted">{t("terminal.perf.legend")}</p>
		</div>
	);
}
