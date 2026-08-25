/**
 * Concept 2 — Switchboard. One permanent line, constant height, never grows.
 *
 * Every live conversation *pair* is one chip: `1141 ⇢ 1660`. A burst of five
 * messages does not add a chip, it thickens one. Chips decay out of the strip
 * after ten quiet minutes, so the strip is empty on a quiet board and never
 * needs dismissing. No text, ever — the strip answers topology, and clicking a
 * chip is what asks for words.
 */

import { MESSAGES, TONE_COLOR, agoLabel } from "./fixtures";

interface Pair {
	key: string;
	fromSeq: number;
	toSeq: number;
	tone: string;
	count: number;
	ago: number;
}

function pairs(): Pair[] {
	const map = new Map<string, Pair>();
	for (const m of MESSAGES) {
		const key = `${m.from.seq}>${m.to.seq}`;
		const found = map.get(key);
		if (found) {
			found.count += 1;
			found.ago = Math.min(found.ago, m.ago);
			continue;
		}
		map.set(key, {
			key,
			fromSeq: m.from.seq,
			toSeq: m.to.seq,
			tone: TONE_COLOR[m.from.tone],
			count: 1,
			ago: m.ago,
		});
	}
	return [...map.values()].sort((a, b) => a.ago - b.ago);
}

export function C2Switchboard() {
	const list = pairs();

	return (
		<div className="w-[46rem] max-w-full">
			<div
				className="flex items-center gap-1.5 h-8 px-2 rounded-full border border-edge/70 overflow-hidden"
				style={{
					maskImage: "linear-gradient(to right, black 92%, transparent)",
					WebkitMaskImage: "linear-gradient(to right, black 92%, transparent)",
					background: "rgb(var(--surface-overlay) / 0.92)",
					backdropFilter: "blur(12px)",
					boxShadow: "var(--shadow-popover, 0 8px 24px -8px rgb(0 0 0 / 0.4))",
				}}
			>
				<span
					className="w-1.5 h-1.5 rounded-full flex-shrink-0"
					style={{ background: "rgb(var(--agent))", animation: "concept-pulse 2s ease-in-out infinite" }}
				/>
				<span className="text-micro font-mono text-fg-muted flex-shrink-0 mr-0.5">traffic</span>
				{list.map((p, i) => (
					<button
						key={p.key}
						type="button"
						className="group flex items-center gap-1 h-5 pl-1.5 pr-1 rounded-full flex-shrink-0 transition-colors"
						style={{
							background: i === 0 ? "rgb(var(--agent) / 0.16)" : "rgb(var(--border-default) / 0.18)",
							border: `1px solid ${i === 0 ? "rgb(var(--agent) / 0.4)" : "rgb(var(--border-default) / 0.3)"}`,
							opacity: 1 - Math.min(0.45, i * 0.09),
						}}
					>
						<span className="text-micro font-mono text-fg-2 tabular-nums">{p.fromSeq}</span>
						<span
							className="text-micro leading-none"
							style={{ color: p.tone, ...(i === 0 ? { animation: "concept-nudge 1.6s ease-in-out infinite" } : {}) }}
						>
							⇢
						</span>
						<span className="text-micro font-mono text-fg tabular-nums">{p.toSeq}</span>
						{p.count > 1 && (
							<span className="text-micro font-mono text-fg-muted tabular-nums">·{p.count}</span>
						)}
						<span className="text-micro font-mono text-fg-muted/70 tabular-nums pl-0.5">{agoLabel(p.ago)}</span>
					</button>
				))}
			</div>
		</div>
	);
}
