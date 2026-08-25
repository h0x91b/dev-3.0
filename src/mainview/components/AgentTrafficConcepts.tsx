/**
 * THROWAWAY CONCEPT SCAFFOLD — not a shipped feature, not on any happy path.
 *
 * Six divergent ways to display agent-to-agent traffic (`dev3 message`), rendered
 * over the live app so each can be screenshotted in situ. Mounted only when the
 * URL carries `?concepts=agent`; renders `null` otherwise.
 *
 * Strings are intentionally hardcoded English: this is concept scaffolding, not
 * product UI, so it deliberately skips the i18n registry rather than polluting
 * three locale files with copy nobody has agreed to yet. Colors are design tokens
 * only, so every concept is honest in both themes.
 */
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

export const CONCEPTS_PARAM = "concepts";

/** Fabricated traffic — a coordinator board mid-burst. */
interface Msg {
	id: number;
	fromSeq: number;
	fromTitle: string;
	toSeq: number;
	toTitle: string;
	text: string;
	ago: string;
	/** Concept 5 only: what a sender-side importance field would carry. */
	blocker?: boolean;
}

const COORD = { seq: 1141, title: "Coordinator — dev3 board" };

const MESSAGES: Msg[] = [
	{
		id: 1,
		fromSeq: 1648,
		fromTitle: "Concept: 3D space for message flow",
		toSeq: COORD.seq,
		toTitle: COORD.title,
		text: "Problem statement written up as a task note. Not restarting from the hub-and-legs form.",
		ago: "just now",
	},
	{
		id: 2,
		fromSeq: COORD.seq,
		fromTitle: COORD.title,
		toSeq: 1660,
		toTitle: "Design six ways to show a message",
		text: "Read PR #1505 before you design anything — do not re-serve what was already rejected.",
		ago: "1m",
	},
	{
		id: 3,
		fromSeq: 1650,
		fromTitle: "Persist an agent-message log",
		toSeq: COORD.seq,
		toTitle: COORD.title,
		text: "I am blocked: 1660 is editing src/mainview/toast.tsx on the same base commit.",
		ago: "4m",
		blocker: true,
	},
	{
		id: 4,
		fromSeq: COORD.seq,
		fromTitle: COORD.title,
		toSeq: 1648,
		toTitle: "Concept: 3D space for message flow",
		text: "Green and rebased is enough. Do not request completion.",
		ago: "9m",
	},
	{
		id: 5,
		fromSeq: 1660,
		fromTitle: "Design six ways to show a message",
		toSeq: COORD.seq,
		toTitle: COORD.title,
		text: "Six concepts scaffolded, screenshotting now.",
		ago: "12m",
	},
	{
		id: 6,
		fromSeq: COORD.seq,
		fromTitle: COORD.title,
		toSeq: 1650,
		toTitle: "Persist an agent-message log",
		text: "Take the log task. 1660 needs history to point at.",
		ago: "17m",
	},
];

/** Every task that appears in the traffic, in first-seen order. */
const PARTICIPANTS = (() => {
	const seen = new Map<number, string>();
	for (const m of MESSAGES) {
		if (!seen.has(m.fromSeq)) seen.set(m.fromSeq, m.fromTitle);
		if (!seen.has(m.toSeq)) seen.set(m.toSeq, m.toTitle);
	}
	return [...seen].map(([seq, title]) => ({ seq, title }));
})();

type ConceptId = "wire" | "ledger" | "cards" | "threads" | "triage" | "arcs";

const CONCEPTS: { id: ConceptId; n: number; label: string }[] = [
	{ id: "wire", n: 1, label: "Wire" },
	{ id: "ledger", n: 2, label: "Ledger" },
	{ id: "cards", n: 3, label: "Card state" },
	{ id: "threads", n: 4, label: "Threads" },
	{ id: "triage", n: 5, label: "Triage" },
	{ id: "arcs", n: 6, label: "Arcs" },
];

/** Bottom edge of the app's own header — where a chrome-level concept starts. */
function useChromeTop(): number {
	const [top, setTop] = useState(56);
	useLayoutEffect(() => {
		function measure() {
			const header = document.querySelector("header");
			if (header) setTop(header.getBoundingClientRect().bottom);
		}
		measure();
		const id = setInterval(measure, 500);
		return () => clearInterval(id);
	}, []);
	return top;
}

export function AgentTrafficConcepts() {
	const enabled = useMemo(() => {
		if (typeof window === "undefined") return false;
		return new URLSearchParams(window.location.search).get(CONCEPTS_PARAM) === "agent";
	}, []);
	const [active, setActive] = useState<ConceptId>("wire");

	// Number keys 1..6 switch concepts, so a screenshot pass never has to hunt for
	// the picker (and the picker can be hidden with 0 for a clean capture).
	const [chromeVisible, setChromeVisible] = useState(true);
	useEffect(() => {
		if (!enabled) return;
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
			if (e.key === "0") setChromeVisible((v) => !v);
			const idx = Number(e.key);
			if (idx >= 1 && idx <= CONCEPTS.length) setActive(CONCEPTS[idx - 1].id);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled]);

	if (!enabled) return null;

	return (
		<>
			{active === "wire" && <ConceptWire />}
			{active === "ledger" && <ConceptLedger />}
			{active === "cards" && <ConceptCardState />}
			{active === "threads" && <ConceptThreads />}
			{active === "triage" && <ConceptTriage />}
			{active === "arcs" && <ConceptArcs />}
			{chromeVisible && <ConceptPicker active={active} onPick={setActive} />}
		</>
	);
}

function ConceptPicker({ active, onPick }: { active: ConceptId; onPick: (id: ConceptId) => void }) {
	return (
		<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[80] flex items-center gap-1 rounded-full border border-edge bg-overlay/95 px-1.5 py-1.5 shadow-2xl backdrop-blur">
			{CONCEPTS.map((c) => (
				<button
					key={c.id}
					type="button"
					onClick={() => onPick(c.id)}
					className={`rounded-full px-3 py-1 text-xs transition-colors ${
						active === c.id
							? "bg-accent text-white"
							: "text-fg-3 hover:bg-elevated hover:text-fg"
					}`}
				>
					<span className="font-mono opacity-60">{c.n}</span> {c.label}
				</button>
			))}
			<span className="px-2 text-micro text-fg-muted">0 hides this</span>
		</div>
	);
}

/* ────────────────────────────────────────────────────────────────────────────
   1 · WIRE — an ambient lane in the chrome. No cards, no text, never dismissed.
   ──────────────────────────────────────────────────────────────────────────── */

function ConceptWire() {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((t) => t + 1), 2600);
		return () => clearInterval(id);
	}, []);
	const chromeTop = useChromeTop();
	const nodes = PARTICIPANTS.slice(0, 6);
	const indexOf = (seq: number) => Math.max(0, nodes.findIndex((n) => n.seq === seq));
	// Two dots in flight at any moment — a burst reads as density, not as a queue.
	const inFlight = [MESSAGES[tick % MESSAGES.length], MESSAGES[(tick + 3) % MESSAGES.length]];

	return (
		<div className="fixed left-0 right-0 z-[60] h-8 border-y border-edge bg-raised/90 backdrop-blur" style={{ top: chromeTop }}>
			<div className="relative flex h-full items-center px-6">
				<div className="absolute left-6 right-6 h-px bg-edge" />
				{nodes.map((n, i) => {
					const busy = inFlight.some((m) => m.fromSeq === n.seq || m.toSeq === n.seq);
					return (
						<div
							key={n.seq}
							className="absolute -translate-x-1/2 flex flex-col items-center"
							style={{ left: `calc(24px + (100% - 48px) * ${i / (nodes.length - 1)})` }}
							title={`#${n.seq} · ${n.title}`}
						>
							<span
								className={`h-2 w-2 rounded-full transition-colors ${
									busy ? "bg-agent" : "bg-fg-muted/50"
								}`}
							/>
							<span
								className={`mt-0.5 font-mono text-micro leading-none transition-colors ${
									busy ? "text-agent" : "text-fg-muted"
								}`}
							>
								{n.seq}
							</span>
						</div>
					);
				})}
				{inFlight.map((m, k) => {
					const a = indexOf(m.fromSeq) / (nodes.length - 1);
					const b = indexOf(m.toSeq) / (nodes.length - 1);
					return (
						<span
							key={`${m.id}-${k}`}
							className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-agent shadow-[0_0_8px_rgb(var(--agent))]"
							style={{
								animation: `concept-wire-travel 2.4s linear infinite`,
								// Custom props drive the keyframes, so one animation serves any pair.
								["--from" as string]: `calc(24px + (100vw - 48px) * ${a})`,
								["--to" as string]: `calc(24px + (100vw - 48px) * ${b})`,
								animationDelay: `${k * 0.9}s`,
							}}
						/>
					);
				})}
			</div>
			<style>{`
				@keyframes concept-wire-travel {
					0%   { transform: translate(var(--from), -50%); opacity: 0; }
					12%  { opacity: 1; }
					88%  { opacity: 1; }
					100% { transform: translate(var(--to), -50%); opacity: 0; }
				}
			`}</style>
		</div>
	);
}

/* ────────────────────────────────────────────────────────────────────────────
   2 · LEDGER — a permanent drawer. History first, "waiting on" at the top.
   ──────────────────────────────────────────────────────────────────────────── */

function ConceptLedger() {
	const chromeTop = useChromeTop();
	const [filter, setFilter] = useState<"all" | "blockers">("all");
	const rows = filter === "all" ? MESSAGES : MESSAGES.filter((m) => m.blocker);
	return (
		<aside className="fixed right-0 bottom-0 z-[60] flex w-80 flex-col border-l border-edge bg-raised/95 backdrop-blur" style={{ top: chromeTop }}>
			<header className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
				<span className="h-2 w-2 rounded-full bg-agent" />
				<h2 className="flex-1 text-sm font-semibold text-fg">Agent traffic</h2>
				<span className="rounded-full bg-agent/15 px-1.5 py-0.5 font-mono text-micro text-agent">6</span>
			</header>

			<div className="border-b border-edge px-3 py-2.5">
				<div className="mb-1.5 text-micro uppercase tracking-wide text-fg-muted">Waiting on</div>
				<div className="flex items-center gap-1.5 text-xs">
					<span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-warning-strong">#1650</span>
					<span className="text-fg-3">blocked by</span>
					<span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-fg-2">#1660</span>
					<span className="ml-auto font-mono text-micro text-fg-muted">4m</span>
				</div>
				<div className="mt-1 flex items-center gap-1.5 text-xs">
					<span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-fg-2">#1141</span>
					<span className="text-fg-3">awaiting reply from</span>
					<span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-fg-2">#1660</span>
					<span className="ml-auto font-mono text-micro text-fg-muted">1m</span>
				</div>
			</div>

			<div className="flex gap-1 px-3 py-2">
				{(["all", "blockers"] as const).map((f) => (
					<button
						key={f}
						type="button"
						onClick={() => setFilter(f)}
						className={`rounded-full px-2 py-0.5 text-micro capitalize transition-colors ${
							filter === f ? "bg-elevated text-fg" : "text-fg-3 hover:text-fg"
						}`}
					>
						{f}
					</button>
				))}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				{rows.map((m) => (
					<button
						key={m.id}
						type="button"
						className={`mb-1 w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated ${
							m.blocker ? "border-l-2 border-warning bg-warning/5" : ""
						}`}
					>
						<div className="flex items-center gap-1 font-mono text-micro">
							<span className="text-fg-2">#{m.fromSeq}</span>
							<span className="text-agent">→</span>
							<span className="text-fg-2">#{m.toSeq}</span>
							<span className="ml-auto text-fg-muted">{m.ago}</span>
						</div>
						<div className="mt-0.5 line-clamp-2 text-xs leading-snug text-fg-3">{m.text}</div>
					</button>
				))}
			</div>
		</aside>
	);
}

/* ────────────────────────────────────────────────────────────────────────────
   3 · CARD STATE — the message lands on the two Kanban cards, and stays there.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Live positions of the real board cards, keyed by the `#seq` they print. Matching
 * on the visible seq (not on DOM order) is what lets the fabricated traffic land on
 * the card it actually names — a chip on the wrong card would not be a mock, it
 * would be a lie about how the concept reads.
 */
function useCardAssignment(): { seq: number; title: string; rect: DOMRect }[] {
	const [cards, setCards] = useState<{ seq: number; rect: DOMRect }[]>([]);
	useLayoutEffect(() => {
		function measure() {
			const found = new Map<number, DOMRect>();
			document.querySelectorAll<HTMLElement>("[data-task-id]").forEach((el) => {
				const rect = el.getBoundingClientRect();
				if (rect.width < 120 || rect.height < 60) return;
				const seq = Number(el.textContent?.match(/#(\d+)/)?.[1]);
				if (!seq || found.has(seq)) return;
				found.set(seq, rect);
			});
			setCards([...found].map(([seq, rect]) => ({ seq, rect })));
		}
		measure();
		const id = setInterval(measure, 500);
		window.addEventListener("resize", measure);
		return () => {
			clearInterval(id);
			window.removeEventListener("resize", measure);
		};
	}, []);
	return useMemo(
		() =>
			cards
				.map((c) => {
					const p = PARTICIPANTS.find((x) => x.seq === c.seq);
					return p ? { ...c, title: p.title } : null;
				})
				.filter((c): c is { seq: number; title: string; rect: DOMRect } => c !== null),
		[cards],
	);
}

function ConceptCardState() {
	const cards = useCardAssignment();
	const bySeq = new Map(cards.map((c) => [c.seq, c]));
	// One chip per card: the freshest counterpart, plus a count when there are more.
	const chips = cards.map((c) => {
		const mine = MESSAGES.filter((m) => m.fromSeq === c.seq || m.toSeq === c.seq);
		if (!mine.length) return null;
		const latest = mine[0];
		const outbound = latest.fromSeq === c.seq;
		const other = outbound ? latest.toSeq : latest.fromSeq;
		return {
			key: c.seq,
			rect: c.rect,
			outbound,
			other,
			count: mine.length,
			ago: latest.ago,
			fresh: latest.id <= 2,
			blocker: mine.some((m) => m.blocker),
		};
	});

	return (
		<div className="pointer-events-none fixed inset-0 z-[60]">
			{chips.filter(Boolean).map((chip) => {
				if (!chip) return null;
				if (!bySeq.has(chip.key)) return null;
				return (
					<div
						key={chip.key}
						className="absolute"
						style={{ left: chip.rect.right - 8, top: chip.rect.top - 9, transform: "translateX(-100%)" }}
					>
						<span
							className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-micro shadow-lg backdrop-blur ${
								chip.blocker
									? "border-warning/50 bg-warning/15 text-warning-strong"
									: chip.fresh
										? "border-agent/50 bg-agent/15 text-agent"
										: "border-edge bg-overlay text-fg-muted"
							}`}
							style={
								chip.fresh
									? { animation: "concept-chip-pulse 2s ease-out infinite" }
									: undefined
							}
						>
							{chip.outbound ? "→" : "←"} #{chip.other}
							{chip.count > 1 && <span className="opacity-60">×{chip.count}</span>}
							<span className="opacity-50">{chip.ago}</span>
						</span>
					</div>
				);
			})}
			<style>{`
				@keyframes concept-chip-pulse {
					0%, 100% { box-shadow: 0 0 0 0 rgb(var(--agent) / 0.5); }
					50%      { box-shadow: 0 0 0 5px rgb(var(--agent) / 0); }
				}
			`}</style>
		</div>
	);
}

/* ────────────────────────────────────────────────────────────────────────────
   4 · THREADS — text first, on purpose. One lane per talking pair.
   ──────────────────────────────────────────────────────────────────────────── */

function ConceptThreads() {
	const pairs = useMemo(() => {
		const map = new Map<string, Msg[]>();
		for (const m of MESSAGES) {
			const key = [m.fromSeq, m.toSeq].sort().join("-");
			map.set(key, [...(map.get(key) ?? []), m]);
		}
		return [...map.entries()].slice(0, 2);
	}, []);

	return (
		<div className="fixed bottom-20 right-4 z-[60] flex w-[22rem] flex-col gap-2">
			{pairs.map(([key, msgs]) => {
				const [a, b] = key.split("-").map(Number);
				const shown = msgs.slice(0, 3);
				const hidden = msgs.length - shown.length;
				return (
					<div
						key={key}
						className="overflow-hidden rounded-xl border border-agent/30 bg-overlay/95 shadow-2xl backdrop-blur"
					>
						<div className="flex items-center gap-1.5 border-b border-edge px-2.5 py-1.5 font-mono text-micro text-fg-muted">
							<span className="text-fg-2">#{a}</span>
							<span className="text-agent">⇄</span>
							<span className="text-fg-2">#{b}</span>
							<span className="ml-auto">{msgs.length} msg</span>
						</div>
						<div className="flex flex-col gap-1 p-2">
							{hidden > 0 && (
								<button type="button" className="self-center text-micro text-fg-muted hover:text-fg-3">
									+{hidden} earlier
								</button>
							)}
							{[...shown].reverse().map((m) => {
								const mine = m.fromSeq === a;
								return (
									<div key={m.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}>
										<div
											className={`max-w-[85%] rounded-lg px-2 py-1 text-xs leading-snug ${
												mine
													? "bg-elevated text-fg-2"
													: "bg-agent/15 text-fg"
											}`}
										>
											<span className="mr-1 font-mono text-micro text-fg-muted">
												#{m.fromSeq}
											</span>
											{m.text}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/* ────────────────────────────────────────────────────────────────────────────
   5 · TRIAGE — silence by default. Only a blocker is allowed to interrupt.
   ──────────────────────────────────────────────────────────────────────────── */

function ConceptTriage() {
	const chromeTop = useChromeTop();
	const blocker = MESSAGES.find((m) => m.blocker);
	const quiet = MESSAGES.length - (blocker ? 1 : 0);
	return (
		<>
			{/* The resting state: one muted counter in the chrome. Chatter never
			    interrupts — it only increments this. */}
			<div className="fixed right-4 z-[60] flex items-center gap-1.5 rounded-full border border-edge bg-raised/90 px-2 py-1 font-mono text-micro text-fg-muted backdrop-blur" style={{ top: chromeTop + 58 }}>
				<span className="h-1.5 w-1.5 rounded-full bg-fg-muted" />
				{quiet} quiet
			</div>

			{blocker && (
				<div className="fixed left-0 right-0 z-[60] border-b border-warning/40 bg-warning/10 backdrop-blur" style={{ top: chromeTop }}>
					<div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-2">
						<span className="h-2.5 w-2.5 rotate-45 rounded-sm bg-warning" />
						<div className="min-w-0 flex-1">
							<div className="font-mono text-micro text-warning-strong">
								#{blocker.fromSeq} → #{blocker.toSeq} · needs you
							</div>
							<div className="truncate text-xs text-fg">{blocker.text}</div>
						</div>
						<button
							type="button"
							className="rounded-lg bg-elevated px-2.5 py-1 text-xs text-fg hover:bg-elevated-hover"
						>
							Open #{blocker.fromSeq}
						</button>
						<button type="button" className="text-xs text-fg-muted hover:text-fg">
							Dismiss
						</button>
					</div>
				</div>
			)}
		</>
	);
}

/* ────────────────────────────────────────────────────────────────────────────
   6 · ARCS — the board itself becomes the graph. A lens, not a notification.
   ──────────────────────────────────────────────────────────────────────────── */

function ConceptArcs() {
	const cards = useCardAssignment();
	const bySeq = new Map(cards.map((c) => [c.seq, c]));
	const edges = useMemo(() => {
		const map = new Map<string, { from: number; to: number; count: number; blocker: boolean }>();
		for (const m of MESSAGES) {
			const key = `${m.fromSeq}->${m.toSeq}`;
			const prev = map.get(key);
			map.set(key, {
				from: m.fromSeq,
				to: m.toSeq,
				count: (prev?.count ?? 0) + 1,
				blocker: prev?.blocker || !!m.blocker,
			});
		}
		return [...map.values()];
	}, []);

	return (
		<div className="pointer-events-none fixed inset-0 z-[60]">
			<svg className="h-full w-full" aria-hidden>
				<defs>
					<marker id="concept-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
						<path d="M0,0 L8,4 L0,8 z" fill="rgb(var(--agent))" />
					</marker>
				</defs>
				{edges.map((e) => {
					const a = bySeq.get(e.from);
					const b = bySeq.get(e.to);
					if (!a || !b) return null;
					const x1 = a.rect.left + a.rect.width / 2;
					const y1 = a.rect.top + a.rect.height / 2;
					const x2 = b.rect.left + b.rect.width / 2;
					const y2 = b.rect.top + b.rect.height / 2;
					// Bow the arc away from the straight line so two directions of the
					// same pair never overlap into one ambiguous stroke.
					const mx = (x1 + x2) / 2 + (y2 - y1) * 0.22;
					const my = (y1 + y2) / 2 - (x2 - x1) * 0.22;
					const stroke = e.blocker ? "rgb(var(--warning))" : "rgb(var(--agent))";
					return (
						<g key={`${e.from}-${e.to}`}>
							<path
								d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`}
								fill="none"
								stroke={stroke}
								strokeWidth={1.5 + Math.min(3, e.count)}
								strokeOpacity={0.75}
								strokeLinecap="round"
								markerEnd="url(#concept-arrow)"
								style={{
									strokeDasharray: "6 8",
									animation: "concept-arc-flow 1.2s linear infinite",
								}}
							/>
							{e.count > 1 && (
								<text
									x={mx}
									y={my}
									textAnchor="middle"
									className="font-mono"
									fontSize="10"
									fill="rgb(var(--agent))"
								>
									×{e.count}
								</text>
							)}
						</g>
					);
				})}
			</svg>
			{cards.map((c) => (
				<span
					key={c.seq}
					className="absolute rounded-full border border-agent/40 bg-overlay/90 px-1.5 py-0.5 font-mono text-micro text-agent shadow-lg"
					style={{ left: c.rect.left + c.rect.width / 2 - 22, top: c.rect.top + c.rect.height / 2 - 9 }}
				>
					#{c.seq}
				</span>
			))}
			<div className="absolute left-1/2 top-24 -translate-x-1/2 rounded-full border border-edge bg-overlay/95 px-3 py-1 text-micro text-fg-3 shadow-xl backdrop-blur">
				Traffic lens · last 20 min · <span className="text-agent">6 messages</span>
			</div>
			<style>{`
				@keyframes concept-arc-flow { to { stroke-dashoffset: -14; } }
			`}</style>
		</div>
	);
}
