/**
 * Six competing ways to show that one task's agent wrote to another's.
 *
 * Throwaway concept scaffolding: hardcoded English strings, mock data, no i18n,
 * no tests. Nothing here is wired to the real `rpc:agentMessage` push — the
 * point is six screenshots in the real app chrome, not a shipped feature.
 */
import { useEffect, useState } from "react";
import { MESSAGES, PAIRS, WEIGHT_DOT, WEIGHT_TEXT } from "./mock";
import type { ConceptMessage, ConceptPair, Weight } from "./mock";

/* ─────────────────────────────── shared bits ─────────────────────────────── */

/** A wire with a dot travelling along it, in the direction the message went. */
function Wire({ w = 30, weight = "normal" as Weight, reverse = false }) {
	const stroke = weight === "blocker" ? "rgb(var(--danger))" : "rgb(var(--agent))";
	return (
		<svg width={w} height="8" viewBox={`0 0 ${w} 8`} className="flex-shrink-0" aria-hidden="true">
			<line x1="0" y1="4" x2={w} y2="4" stroke={stroke} strokeWidth="1" opacity="0.35" />
			<path
				d={reverse ? `M 6 1 L 1 4 L 6 7` : `M ${w - 6} 1 L ${w - 1} 4 L ${w - 6} 7`}
				fill="none"
				stroke={stroke}
				strokeWidth="1.25"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle r="1.75" fill={stroke}>
				<animate
					attributeName="cx"
					values={reverse ? `${w};0` : `0;${w}`}
					dur="2.4s"
					repeatCount="indefinite"
				/>
				<animate attributeName="cy" values="4;4" dur="2.4s" repeatCount="indefinite" />
				<animate attributeName="opacity" values="0;1;1;0" dur="2.4s" repeatCount="indefinite" />
			</circle>
		</svg>
	);
}

function Seq({ n, dim = false }: { n: number; dim?: boolean }) {
	return <span className={`font-mono text-micro ${dim ? "text-fg-3" : "text-fg-2"}`}>#{n}</span>;
}

function Dot({ weight }: { weight: Weight }) {
	return <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${WEIGHT_DOT[weight]}`} />;
}

/** Caption every concept carries so a screenshot is self-identifying. */
export function ConceptCaption({ n, title, note }: { n: number; title: string; note: string }) {
	return (
		<div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[80] pointer-events-none flex items-center gap-2 rounded-full bg-overlay/95 border border-edge px-3 py-1.5 shadow-popover">
			<span className="font-mono text-dense text-agent">C{n}</span>
			<span className="text-xs text-fg">{title}</span>
			<span className="text-micro text-fg-muted">— {note}</span>
		</div>
	);
}

/* ───────────────────── C1 · Wire — the one-line transient ────────────────── */

/**
 * The toast, reduced to a single 30px line. Both identities and the direction
 * lead; the text is what is left over and truncates without apology. A burst
 * from one pair folds into ×N on the same line rather than stacking cards.
 */
export function C1Wire() {
	return (
		<div className="fixed top-14 right-4 z-[60] flex flex-col gap-1.5 w-[27rem] max-w-[calc(100vw-2rem)]">
			{MESSAGES.slice(0, 3).map((m, i) => (
				<WireChip key={m.id} m={m} count={i === 2 ? 3 : 1} expanded={i === 0} />
			))}
		</div>
	);
}

function WireChip({ m, count, expanded }: { m: ConceptMessage; count: number; expanded: boolean }) {
	const accentRail = m.weight === "blocker" ? "bg-danger" : "bg-agent";
	return (
		<div
			className={`group relative flex items-center gap-2 overflow-hidden rounded-full border border-edge bg-overlay/95 pl-3 pr-2 shadow-popover backdrop-blur-sm ${
				expanded ? "h-auto py-2 rounded-2xl" : "h-8"
			}`}
		>
			<span className={`absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full ${accentRail}`} />
			<Seq n={m.fromSeq} />
			<Wire weight={m.weight} />
			<Seq n={m.toSeq} />
			<span className="h-3.5 w-px bg-edge flex-shrink-0" />
			<span className={`min-w-0 flex-1 text-xs text-fg-2 ${expanded ? "" : "truncate"}`}>{m.text}</span>
			{count > 1 && (
				<span className="flex-shrink-0 rounded-full bg-raised px-1.5 font-mono text-dense text-fg-3">×{count}</span>
			)}
			<span className="flex-shrink-0 font-mono text-dense text-fg-muted">{m.ago}</span>
		</div>
	);
}

/* ──────────────── C2 · Switchboard — permanent chrome readout ─────────────── */

/**
 * No arrival UI at all. One ambient glyph in the global header counts live
 * conversations; the popover is the whole answer, sorted by who has been
 * waiting longest. A message costs the human zero attention until he looks.
 */
export function C2Switchboard({ open }: { open: boolean }) {
	return (
		<div className="fixed top-[2.6rem] right-[11.5rem] z-[60] flex flex-col items-end gap-2">
			<button
				type="button"
				className="flex items-center gap-1.5 rounded-lg border border-agent/30 bg-agent/10 px-2 py-1.5"
			>
				<svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
					{[3, 7, 11].map((y, i) => (
						<g key={y}>
							<line x1="1" y1={y} x2="17" y2={y} stroke="rgb(var(--agent))" strokeWidth="1" opacity="0.3" />
							<circle r="1.5" cy={y} fill="rgb(var(--agent))">
								<animate
									attributeName="cx"
									values={i === 1 ? "17;1" : "1;17"}
									dur={`${2 + i * 0.6}s`}
									repeatCount="indefinite"
								/>
							</circle>
						</g>
					))}
				</svg>
				<span className="font-mono text-micro text-agent">4</span>
			</button>

			{open && (
				<div className="w-[23rem] rounded-xl border border-edge bg-overlay shadow-popover overflow-hidden">
					<div className="flex items-baseline justify-between px-3 py-2 border-b border-edge">
						<span className="text-xs text-fg">Agents talking</span>
						<span className="font-mono text-dense text-fg-muted">4 pairs · 14 messages today</span>
					</div>
					{PAIRS.map((p) => (
						<div key={p.id} className="flex items-center gap-2 px-3 py-2 border-b border-edge/50 last:border-0">
							<Dot weight={p.weight} />
							<Seq n={p.aSeq} />
							<Wire w={22} weight={p.weight} />
							<Seq n={p.bSeq} />
							<span className="min-w-0 flex-1 truncate text-micro text-fg-3">{p.last}</span>
							{p.waiting ? (
								<span className={`flex-shrink-0 font-mono text-dense ${WEIGHT_TEXT[p.weight]}`}>
									waiting {p.waiting}
								</span>
							) : (
								<span className="flex-shrink-0 font-mono text-dense text-fg-muted">{p.ago}</span>
							)}
						</div>
					))}
					<button type="button" className="w-full px-3 py-2 text-left text-micro text-accent bg-raised/50">
						Open the full traffic log ⇧⌘M
					</button>
				</div>
			)}
		</div>
	);
}

/* ─────────────── C3 · Board wiring — topology drawn on the board ─────────── */

interface Link {
	d: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/** Arc apex — where the pair's label sits. */
	lx: number;
	ly: number;
	pair: ConceptPair;
}

/** Which cards each wire connects, by board position. */
const WIRE_INDEXES: Array<[number, number]> = [
	[0, 2],
	[1, 3],
	[0, 4],
	[2, 5],
];

/**
 * The swing. No notification anywhere: while two tasks are in conversation, the
 * board draws the wire between their actual cards. Direction, volume and
 * staleness are the line's own properties, and the whole topology is one glance.
 * Desktop-only by construction — a card that is off-screen has no wire to draw.
 */
export function C3BoardWiring() {
	const [links, setLinks] = useState<Link[]>([]);

	useEffect(() => {
		function measure() {
			// `data-task-id` appears on more than one node per card (board + carousel),
			// so dedupe by the id itself or every wire connects a card to itself.
			const seen = new Map<string, DOMRect>();
			for (const el of document.querySelectorAll<HTMLElement>("[data-task-id]")) {
				const id = el.dataset.taskId;
				const rect = el.getBoundingClientRect();
				if (!id || seen.has(id) || rect.width < 40) continue;
				seen.set(id, rect);
			}
			const rects = Array.from(seen.values());
			const next: Link[] = [];
			WIRE_INDEXES.forEach(([ia, ib], i) => {
				const ra = rects[ia];
				const rb = rects[ib];
				const pair = PAIRS[i];
				if (!ra || !rb || !pair) return;
				const y1 = ra.top + ra.height / 2;
				const y2 = rb.top + rb.height / 2;
				const sameColumn = Math.abs(ra.left - rb.left) < 40;
				if (sameColumn) {
					// Both ends on the right edge, bowing out into the gutter — a wire
					// between two cards of one column has nowhere else to go.
					const x = ra.right - 6;
					const bow = 80 + i * 40;
					// Two arcs can share a mid-y; nudge alternate labels so the pills
					// never sit on top of each other.
					const nudge = i % 2 === 0 ? -16 : 16;
					next.push({
						d: `M ${x} ${y1} C ${x + bow} ${y1}, ${x + bow} ${y2}, ${x} ${y2}`,
						x1: x,
						y1,
						x2: x,
						y2,
						lx: x + bow * 0.72,
						ly: (y1 + y2) / 2 + nudge,
						pair,
					});
					return;
				}
				const x1 = ra.right - 6;
				const x2 = rb.left + 6;
				const mx = (x1 + x2) / 2;
				const lift = Math.max(30, Math.abs(y2 - y1) * 0.4);
				next.push({
					d: `M ${x1} ${y1} C ${mx} ${y1 - lift}, ${mx} ${y2 - lift}, ${x2} ${y2}`,
					x1,
					y1,
					x2,
					y2,
					lx: mx,
					ly: (y1 + y2) / 2 - lift * 0.75,
					pair,
				});
			});
			setLinks(next);
		}
		measure();
		const id = window.setInterval(measure, 500);
		window.addEventListener("resize", measure);
		return () => {
			window.clearInterval(id);
			window.removeEventListener("resize", measure);
		};
	}, []);

	return (
		// An SVG is a replaced element: `inset-0` alone leaves it at its intrinsic
		// 300×150 and clips every wire away, so the explicit size is load-bearing.
		<svg className="fixed inset-0 w-screen h-screen z-[60] pointer-events-none" aria-hidden="true">
			{links.map(({ d, x1, y1, x2, y2, lx, ly, pair }) => {
				const stroke = pair.weight === "blocker" ? "rgb(var(--danger))" : "rgb(var(--agent))";
				const width = pair.weight === "chatter" ? 1 : 1.75;
				return (
					<g key={pair.id}>
						<path d={d} fill="none" stroke={stroke} strokeWidth={width + 4} opacity="0.08" />
						<path
							d={d}
							fill="none"
							stroke={stroke}
							strokeWidth={width}
							opacity={pair.weight === "chatter" ? 0.35 : 0.8}
							strokeDasharray="5 7"
						>
							<animate attributeName="stroke-dashoffset" values="24;0" dur="1.6s" repeatCount="indefinite" />
						</path>
						<circle cx={x2} cy={y2} r="3.5" fill={stroke} opacity="0.9" />
						<circle cx={x1} cy={y1} r="2" fill={stroke} opacity="0.5" />
						<g transform={`translate(${lx - 42} ${ly - 9})`}>
							<rect
								width="84"
								height="18"
								rx="9"
								fill="rgb(var(--surface-overlay))"
								stroke={stroke}
								strokeOpacity="0.35"
							/>
							<text
								x="42"
								y="12.5"
								textAnchor="middle"
								fontSize="10"
								fontFamily="monospace"
								fill="rgb(var(--text-secondary))"
							>
								#{pair.aSeq}→#{pair.bSeq} ×{pair.count}
							</text>
						</g>
					</g>
				);
			})}
		</svg>
	);
}

/* ─────────────── C4 · Sidebar lane — the queue answers "who waits" ────────── */

/**
 * Traffic folded into the work queue the human already scans. Each row keeps
 * its own identity and gains one inbound/outbound micro-arrow with an unread
 * count; the group is ordered by how long someone has been owed an answer, so
 * the top row IS the stall. Survives narrow — it is a list, not a diagram.
 */
export function C4SidebarLane() {
	return (
		<div className="fixed left-3 top-[5.5rem] z-[60] w-[20rem] overflow-hidden rounded-xl border border-edge bg-base shadow-popover flex flex-col">
			<div className="px-3 py-2 border-b border-edge flex items-baseline gap-2">
				<span className="text-xs text-fg">Talking</span>
				<span className="font-mono text-dense text-fg-muted">4 pairs</span>
				<span className="ml-auto font-mono text-dense text-fg-muted">▲ above NEEDS YOU</span>
			</div>
			{PAIRS.map((p) => (
				<div key={p.id} className="flex items-start gap-2 px-3 py-2 border-b border-edge/50">
					<span className={`mt-1.5 h-6 w-[3px] rounded-full ${p.weight === "blocker" ? "bg-danger" : "bg-agent"}`} />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<Wire w={16} weight={p.weight} reverse />
							<Seq n={p.aSeq} />
							<span className="min-w-0 flex-1 truncate text-xs text-fg">{p.aTitle}</span>
							{p.count > 1 && (
								<span className="flex-shrink-0 rounded-full bg-agent/15 px-1.5 font-mono text-dense text-agent">
									{p.count}
								</span>
							)}
						</div>
						<div className="mt-0.5 truncate text-micro text-fg-3">{p.last}</div>
						<div className="mt-0.5 font-mono text-dense text-fg-muted">
							{p.waiting ? (
								<span className={WEIGHT_TEXT[p.weight]}>owes you an answer · {p.waiting}</span>
							) : (
								<span>answered · {p.ago}</span>
							)}
						</div>
					</div>
				</div>
			))}
			<div className="px-3 py-2 border-t border-edge text-micro text-fg-muted">
				Your task queue continues below this group.
			</div>
		</div>
	);
}

/* ──────────────── C5 · Terminal seam — the message where it landed ────────── */

/**
 * Nothing floats. The receiving task's terminal grows a hairline seam at the
 * moment the text was injected, and a gutter ruler of past seams beside the
 * scrollback. The human reads the message in the only place it actually exists,
 * and the ruler is a permanent record he can scroll back through.
 */
export function C5TerminalSeam() {
	return (
		<div className="fixed left-1/2 bottom-16 -translate-x-1/2 z-[60] w-[58rem] max-w-[calc(100vw-3rem)] rounded-xl border border-edge bg-base shadow-popover overflow-hidden">
			<div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
				<span className="font-mono text-dense text-fg-muted">#1660 · claude · pane 1</span>
			</div>
			<div className="flex">
				<div className="w-9 flex-shrink-0 border-r border-edge py-2 flex flex-col items-center gap-3">
					{MESSAGES.slice(0, 4).map((m) => (
						<span key={m.id} className="flex flex-col items-center gap-1">
							<Dot weight={m.weight} />
							<span className="font-mono text-nano text-fg-muted">{m.fromSeq % 100}</span>
						</span>
					))}
				</div>
				<div className="min-w-0 flex-1 p-3 font-mono text-micro text-fg-3 leading-relaxed">
					<div>$ bun run lint</div>
					<div className="text-success-strong">✓ no type errors</div>
					<div className="my-2 flex items-center gap-2">
						<span className="h-px flex-1 bg-agent/30" />
						<span className="flex items-center gap-1.5 rounded-full border border-agent/30 bg-agent/10 px-2 py-0.5">
							<Wire w={18} reverse />
							<span className="text-dense text-agent">#1141 Coordinator</span>
							<span className="text-nano text-fg-muted">14:32</span>
						</span>
						<span className="h-px flex-1 bg-agent/30" />
					</div>
					<div className="text-fg-2">Rebase on origin/main before you push — 1505 is closed, not merged.</div>
					<div className="mt-2">$ git fetch origin main</div>
					<div className="my-2 flex items-center gap-2">
						<span className="h-px flex-1 bg-danger/30" />
						<span className="flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5">
							<Wire w={18} weight="blocker" reverse />
							<span className="text-dense text-danger">#1503 Windows shard</span>
							<span className="text-nano text-fg-muted">14:34</span>
						</span>
						<span className="h-px flex-1 bg-danger/30" />
					</div>
					<div className="text-fg-2">Blocked: you are editing src/mainview/toast.tsx and so am I.</div>
					<div className="mt-2 text-fg-muted">$ █</div>
				</div>
			</div>
		</div>
	);
}

/* ──────────────── C6 · Traffic log — the permanent record ─────────────────── */

/**
 * The answer to "what happened while I was away". A destination, not an event:
 * pairs on the left, a reverse-chronological ledger on the right, importance in
 * its own column. Arrival changes nothing on screen except a dot in the header.
 */
export function C6TrafficLog() {
	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-base/70 backdrop-blur-sm">
			<div className="w-[58rem] max-w-[calc(100vw-3rem)] max-h-[80vh] overflow-hidden rounded-2xl border border-edge bg-overlay shadow-popover flex flex-col">
				<div className="flex items-baseline gap-3 px-4 py-3 border-b border-edge">
					<span className="text-base text-fg">Agent traffic</span>
					<span className="font-mono text-micro text-fg-muted">dev-3.0 · today · 14 messages · 4 pairs</span>
					<span className="ml-auto font-mono text-dense text-fg-muted">⇧⌘M</span>
				</div>
				<div className="flex min-h-0 flex-1">
					<div className="w-[17rem] flex-shrink-0 border-r border-edge overflow-auto">
						{PAIRS.map((p, i) => (
							<div
								key={p.id}
								className={`flex items-center gap-2 px-3 py-2.5 border-b border-edge/50 ${i === 0 ? "bg-raised" : ""}`}
							>
								<Dot weight={p.weight} />
								<Seq n={p.aSeq} />
								<Wire w={20} weight={p.weight} />
								<Seq n={p.bSeq} dim />
								<span className="ml-auto font-mono text-dense text-fg-muted">×{p.count}</span>
							</div>
						))}
						<div className="px-3 py-2 text-micro text-fg-muted">
							Pairs are the index. Pick one to read only its thread; the ledger on the right is everything.
						</div>
					</div>
					<div className="min-w-0 flex-1 overflow-auto">
						{MESSAGES.map((m) => (
							<LogRow key={m.id} m={m} />
						))}
						<div className="px-4 py-2 text-micro text-fg-muted">— yesterday —</div>
						{MESSAGES.slice(0, 2).map((m) => (
							<LogRow key={`y${m.id}`} m={{ ...m, ago: "yesterday 18:04" }} />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

function LogRow({ m }: { m: ConceptMessage }) {
	return (
		<div className="flex items-start gap-3 px-4 py-2.5 border-b border-edge/50">
			<span className="mt-1.5">
				<Dot weight={m.weight} />
			</span>
			<span className="mt-0.5 flex flex-shrink-0 items-center gap-1.5">
				<Seq n={m.fromSeq} />
				<Wire w={20} weight={m.weight} />
				<Seq n={m.toSeq} dim />
			</span>
			<span className="min-w-0 flex-1 text-xs text-fg-2">{m.text}</span>
			<span className="flex-shrink-0 font-mono text-dense text-fg-muted">{m.ago}</span>
		</div>
	);
}
