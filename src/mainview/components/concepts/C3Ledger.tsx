/**
 * Concept 3 — Ledger. No notification at all; a permanent surface instead.
 *
 * The one concept that answers "who was waiting on whom yesterday". Reads the
 * on-disk log that already exists (`readAgentMessageLog`, currently consumed by
 * nothing) and groups by conversation PAIR rather than by time, so the surface
 * is a state readout — a conversation list — not a feed of events. The
 * per-pair sparkline says when the traffic happened without spending rows on it.
 */

import { MESSAGES, TONE_COLOR, shortTitle, agoLabel, type ConceptMessage } from "./fixtures";

interface Thread {
	key: string;
	a: ConceptMessage["from"];
	b: ConceptMessage["to"];
	messages: ConceptMessage[];
	last: ConceptMessage;
}

function threads(): Thread[] {
	const map = new Map<string, Thread>();
	for (const m of MESSAGES) {
		const key = [m.from.seq, m.to.seq].sort((x, y) => x - y).join("-");
		const found = map.get(key);
		if (found) {
			found.messages.push(m);
			if (m.ago < found.last.ago) found.last = m;
			continue;
		}
		map.set(key, { key, a: m.from, b: m.to, messages: [m], last: m });
	}
	return [...map.values()].sort((x, y) => x.last.ago - y.last.ago);
}

/** Bars over a 60-minute window, newest on the right. */
function Sparkline({ messages }: { messages: ConceptMessage[] }) {
	const buckets = Array.from({ length: 12 }, (_, i) => {
		const from = 60 - (i + 1) * 5;
		const to = 60 - i * 5;
		return messages.filter((m) => m.ago >= from && m.ago < to).length;
	});
	const max = Math.max(1, ...buckets);
	return (
		<div className="flex items-end gap-px h-4" aria-hidden>
			{buckets.map((n, i) => (
				<div
					key={i}
					className="w-1 rounded-sm"
					style={{
						height: `${Math.max(2, (n / max) * 16)}px`,
						background: n ? "rgb(var(--agent) / 0.8)" : "rgb(var(--border-default) / 0.35)",
					}}
				/>
			))}
		</div>
	);
}

export function C3Ledger() {
	const list = threads();
	const total = MESSAGES.length;

	return (
		<div className="w-[27rem] bg-raised border border-edge rounded-xl overflow-hidden shadow-2xl">
			<div className="flex items-center justify-between px-4 h-11 border-b border-edge/60">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-fg">Traffic</span>
					<span className="text-micro font-mono text-fg-muted">{total} today</span>
				</div>
				<div className="flex items-center gap-1 text-micro font-mono text-fg-muted">
					<span className="px-1.5 py-0.5 rounded bg-elevated border border-edge/60">g t</span>
				</div>
			</div>

			<div className="divide-y divide-edge/25">
				{list.map((th) => {
					const dir = th.last.from.seq === th.a.seq;
					return (
						<div key={th.key} className="px-4 py-2.5 hover:bg-raised-hover transition-colors cursor-pointer">
							<div className="flex items-center gap-2 mb-1">
								<span
									className="w-1 h-3.5 rounded-full flex-shrink-0"
									style={{ background: TONE_COLOR[th.a.tone] }}
								/>
								<span className="text-micro font-mono text-fg tabular-nums">#{th.a.seq}</span>
								<span className="text-micro" style={{ color: "rgb(var(--agent))" }}>
									{dir ? "→" : "←"}
								</span>
								<span className="text-micro font-mono text-fg tabular-nums">#{th.b.seq}</span>
								<span
									className="w-1 h-3.5 rounded-full flex-shrink-0"
									style={{ background: TONE_COLOR[th.b.tone] }}
								/>
								<span className="text-micro font-mono text-fg-muted truncate flex-1 min-w-0">
									{shortTitle(dir ? th.b : th.a, 20)}
								</span>
								<Sparkline messages={th.messages} />
								<span className="text-micro font-mono text-fg-muted tabular-nums w-6 text-right">
									{agoLabel(th.last.ago)}
								</span>
							</div>
							<div className="text-sm text-fg-2 leading-snug line-clamp-1 pl-3">{th.last.body}</div>
							{th.messages.length > 1 && (
								<div className="text-micro font-mono text-fg-muted pl-3 pt-0.5">
									+{th.messages.length - 1} earlier
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
