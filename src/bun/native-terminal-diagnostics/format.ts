/**
 * Compact, deterministic human-readable rendering of a native terminal
 * diagnostic snapshot (seq 1258). Pure and side-effect free: it reads only the
 * snapshot produced by `buildDiagnosticsSnapshot`, emits a fixed line order, and
 * renders every unavailable fact as `unknown` — so it can never surface anything
 * the snapshot itself already redacted.
 */

import type { DiagnosticFact, NativeTerminalDiagnosticsSnapshot } from "./snapshot";

function render<T>(fact: DiagnosticFact<T>, show: (value: T) => string = String): string {
	return fact.known ? show(fact.value) : "unknown";
}

/** Format a snapshot into aligned `label  value` lines. Deterministic ordering. */
export function formatDiagnosticsSnapshot(snapshot: NativeTerminalDiagnosticsSnapshot): string {
	const { identity, process: proc, writer, timing, counters } = snapshot;

	const lines: [string, string][] = [
		["session", render(identity.sessionId)],
		["view", render(identity.viewId)],
		["lifecycle", render(snapshot.lifecycle)],
		["freshness", render(snapshot.freshness, (f) => `age=${f.ageMs}ms ${f.stale ? "stale" : "fresh"}`)],
		["protocol", render(identity.protocolVersion, (v) => `v${v}`)],
		["runtime", render(identity.runtimeVersion)],
		["artifact", render(identity.hostArtifactVersion)],
		["platform", render(identity.platform)],
		["host-pid", render(proc.hostPid)],
		["shell-pid", render(proc.shellPid)],
		["writer", `${render(writer.present, (v) => (v ? "attached" : "none"))} (${render(writer.role)})`],
		["created", render(timing.createdAt)],
		["updated", render(timing.updatedAt)],
		["shell-started", render(timing.shellStartedAt)],
		["last-attach", render(timing.lastAttachAt)],
		[
			"queue",
			render(
				counters.queue,
				(q) =>
					`pending=${q.pendingBytes}B/${q.pendingEvents}ev peak=${q.highWaterBytes}B/${q.highWaterEvents}ev cap=${q.maxBytes}B/${q.maxEvents}ev lastSeq=${q.lastSeq} pressure=${q.pressure} slowEpisodes=${q.slowConsumerEpisodes} dropped=${q.droppedChunks}c/${q.droppedBytes}B/${q.droppedResizes}r${q.overflowed ? " OVERFLOWED" : ""}`,
			),
		],
		[
			"persist",
			render(
				counters.persistence,
				(p) =>
					`writes=${p.writes} skipped=${p.skippedIdentical} coalesced=${p.coalesced} failures=${p.failures} last=${p.lastBytes}B max=${p.maxBytes}B total=${p.totalBytes}B minInterval=${p.minIntervalMs}ms lastWriteAt=${p.lastWriteAtMs ?? "never"}${p.inFlight ? " IN-FLIGHT" : ""}`,
			),
		],
		[
			"resync",
			render(counters.resync, (r) => `gaps=${r.gaps} missedSeqs=${r.missedSeqs} lastGapAtSeq=${r.lastGapAtSeq ?? "none"}`),
		],
		[
			"parser",
			render(
				counters.parserSnapshot,
				(s) => `health=${s.health} watermark=${s.watermarkSeq} frames=${s.frames} bytes=${s.bytes} resizes=${s.resizes} replies=${s.replies} age=${s.ageMs}ms`,
			),
		],
	];

	const width = Math.max(...lines.map(([label]) => label.length));
	const header = `native-terminal diagnostics v${snapshot.version} @ ${snapshot.capturedAt}`;
	const body = lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
	return [header, ...body].join("\n");
}
