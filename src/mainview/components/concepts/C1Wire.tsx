/**
 * Concept 1 — Wire. Ambient, zero-chrome, no popup at all.
 *
 * The Active Tasks sidebar grows a 30px gutter on its left edge. Every message
 * is an arc from the sender's row to the receiver's row, drawn in the sender's
 * status colour with an arrowhead at the receiving end. The newest arc carries a
 * travelling spark; older arcs fade over ten minutes and vanish. Nothing is
 * added above or below, so the height cost is exactly zero.
 */

import { MESSAGES, TONE_COLOR, WORKERS, COORDINATOR, shortTitle, type ConceptTask } from "./fixtures";

const ROWS: ConceptTask[] = [COORDINATOR, ...WORKERS];
const ROW_H = 56;
const GUTTER = 46;
const HEADER_H = 33;

function rowY(seq: number): number {
	const i = ROWS.findIndex((r) => r.seq === seq);
	return (i < 0 ? 0 : i) * ROW_H + ROW_H / 2;
}

export function C1Wire() {
	const live = MESSAGES.slice(0, 5);
	const height = ROWS.length * ROW_H;

	return (
		<div className="w-[24rem] bg-raised border border-edge rounded-xl overflow-hidden shadow-2xl">
			<div
				className="px-3 flex items-center text-micro font-mono text-fg-muted uppercase tracking-wider border-b border-edge/60"
				style={{ height: HEADER_H }}
			>
				Active tasks
			</div>
			<div className="flex" style={{ height }}>
				{/* The wire gutter — arcs only, no labels, no chrome. */}
				<svg
					width={GUTTER}
					height={height}
					className="flex-shrink-0"
					style={{ background: "rgb(var(--surface-base) / 0.45)" }}
					aria-hidden
				>
					<defs>
						{live.map((m) => (
							<marker
								key={`m${m.id}`}
								id={`c1-head-${m.id}`}
								viewBox="0 0 6 6"
								refX="5"
								refY="3"
								markerWidth="5"
								markerHeight="5"
								orient="auto"
							>
								<path d="M0,0 L6,3 L0,6 z" fill={TONE_COLOR[m.from.tone]} />
							</marker>
						))}
					</defs>
					{live.map((m, i) => {
						const a = rowY(m.from.seq);
						const b = rowY(m.to.seq);
						// Control point near the gutter's LEFT edge: the further back the
						// message, the wider its arc bows out, so overlapping pairs stay
						// distinguishable instead of collapsing onto one line.
						const bow = 4 + i * 7.5;
						const d = `M ${GUTTER - 1} ${a} C ${bow} ${a}, ${bow} ${b}, ${GUTTER - 2} ${b}`;
						const fade = 0.95 - i * 0.14;
						return (
							<g key={m.id}>
								<path
									d={d}
									fill="none"
									stroke={TONE_COLOR[m.from.tone]}
									strokeWidth={i === 0 ? 2 : 1.4}
									strokeOpacity={fade}
									strokeLinecap="round"
									markerEnd={`url(#c1-head-${m.id})`}
								/>
								{i === 0 && (
									<>
										<path
											d={d}
											fill="none"
											stroke={TONE_COLOR[m.from.tone]}
											strokeWidth={4}
											strokeOpacity={0.18}
											style={{ filter: "blur(3px)" }}
										/>
										<circle r={2.6} fill={TONE_COLOR[m.from.tone]}>
											<animateMotion dur="2.2s" repeatCount="indefinite" path={d} />
											<animate attributeName="opacity" values="0;1;1;0" dur="2.2s" repeatCount="indefinite" />
										</circle>
									</>
								)}
							</g>
						);
					})}
				</svg>

				<div className="flex-1 min-w-0 border-l border-edge/30">
					{ROWS.map((task) => (
						<div
							key={task.seq}
							className="flex items-center gap-2.5 px-3 border-b border-edge/25 last:border-0"
							style={{ height: ROW_H }}
						>
							<div className="w-0.5 h-7 rounded-full flex-shrink-0" style={{ background: TONE_COLOR[task.tone] }} />
							<div className="min-w-0 flex-1">
								<div className="text-sm text-fg truncate leading-tight">{shortTitle(task, 28)}</div>
								<div className="text-micro font-mono text-fg-muted">#{task.seq}</div>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
