import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";

/**
 * One agent→agent message as it appears in a toast. Both endpoints are click
 * targets: the sender is where a reply gets typed, the receiver is where the
 * text landed, and which one the user wants depends on why they looked.
 */
export interface AgentToastLink {
	fromTaskId: string;
	fromSeq: number;
	fromTitle?: string;
	toTaskId: string;
	toSeq: number;
	toTitle?: string;
	/** Absent when the sending task's project is unknown, which makes it unopenable. */
	onOpenFrom?: () => void;
	onOpenTo: () => void;
}

export interface AgentToastItem {
	/** Toast entry id of the message that produced this row. */
	id: number;
	link: AgentToastLink;
	preview: string;
}

/**
 * A burst of agent traffic collapsed onto one card. `hubTaskId` is the task every
 * message touches — the coordinator, whether it is fanning out or being answered.
 * A single message has no hub: the receiving task takes that place, because that
 * is where the text landed.
 */
export interface AgentToastGroup {
	items: AgentToastItem[];
	hubTaskId?: string;
}

/**
 * Counterparts drawn per direction before the rest collapse into a "+N" row.
 * Two, not more: four legs already measure ~314px tall, and this form's whole
 * cost is vertical.
 */
export const MAX_AGENT_LEGS = 2;

interface Endpoint {
	taskId: string;
	seq: number;
	title?: string;
	onOpen?: () => void;
}

function sender(link: AgentToastLink): Endpoint {
	return { taskId: link.fromTaskId, seq: link.fromSeq, title: link.fromTitle, onOpen: link.onOpenFrom };
}

function receiver(link: AgentToastLink): Endpoint {
	return { taskId: link.toTaskId, seq: link.toSeq, title: link.toTitle, onOpen: link.onOpenTo };
}

/** The participant a new message would share with an existing group, if any. */
export function sharedParticipant(group: AgentToastGroup, link: AgentToastLink): string | undefined {
	if (group.hubTaskId) {
		const hub = group.hubTaskId;
		return link.fromTaskId === hub || link.toTaskId === hub ? hub : undefined;
	}
	const first = group.items[0]?.link;
	if (!first) return undefined;
	const mine = new Set([link.fromTaskId, link.toTaskId]);
	// Receiver first: when a second message repeats the same pair BOTH ends match,
	// and the lone message already drew that task as the hub. Preferring the sender
	// would flip the whole card inside out on the second message.
	if (mine.has(first.toTaskId)) return first.toTaskId;
	if (mine.has(first.fromTaskId)) return first.fromTaskId;
	return undefined;
}

/**
 * Which task the composition is built around. With a hub it is that task; with a
 * single message it is the receiver, so the card reads "landed here, sent by X".
 */
function hubOf(group: AgentToastGroup): { taskId: string; endpoint: Endpoint } | undefined {
	const first = group.items[0]?.link;
	if (!first) return undefined;
	if (!group.hubTaskId) return { taskId: first.toTaskId, endpoint: receiver(first) };
	for (const { link } of group.items) {
		if (link.fromTaskId === group.hubTaskId) return { taskId: group.hubTaskId, endpoint: sender(link) };
		if (link.toTaskId === group.hubTaskId) return { taskId: group.hubTaskId, endpoint: receiver(link) };
	}
	return undefined;
}

/** One counterpart of the hub, with every message it exchanged folded into it. */
interface Leg {
	endpoint: Endpoint;
	/** Newest message on this leg — the older ones live only in the count. */
	preview: string;
	count: number;
	inbound: boolean;
}

/**
 * Collapse the burst by COUNTERPART, not by message: five "тест N" from one task
 * is one box carrying `×5`, which is the whole reason the earlier node-per-message
 * form was unreadable. Newest counterpart last, matching arrival order.
 */
function legsOf(group: AgentToastGroup, hubTaskId: string): Leg[] {
	const order: string[] = [];
	const byKey = new Map<string, Leg>();
	for (const { link, preview } of group.items) {
		const inbound = link.toTaskId === hubTaskId;
		const endpoint = inbound ? sender(link) : receiver(link);
		const key = `${endpoint.taskId}:${inbound ? "in" : "out"}`;
		const existing = byKey.get(key);
		if (existing) {
			existing.count += 1;
			existing.preview = preview;
			continue;
		}
		order.push(key);
		byKey.set(key, { endpoint, preview, count: 1, inbound });
	}
	return order.map((key) => byKey.get(key)!);
}

interface Wire {
	d: string;
	inbound: boolean;
}

/** Slow enough to read as "this channel is alive" without asking to be watched. */
const PULSE_TRAVEL_MS = 2_600;
const PULSE_GAP_MS = 1_100;
const PULSE_STAGGER_MS = 430;
const PULSE_FADE = 0.16;
const PULSE_PEAK = 0.85;

function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Travelling dots, one per wire, looping for as long as the card lives. Driven
 * imperatively rather than by React state: this is a 60fps position, not app data.
 */
function usePulses(svgRef: React.RefObject<SVGSVGElement | null>, wires: Wire[]): void {
	useEffect(() => {
		const svg = svgRef.current;
		if (!svg || !wires.length) return;
		const paths = Array.from(svg.querySelectorAll<SVGPathElement>("path[data-wire]"));
		const dots = Array.from(svg.querySelectorAll<SVGCircleElement>("circle[data-pulse]"));
		if (!paths.length || paths.length !== dots.length) return;
		// `getTotalLength` is absent in happy-dom; without geometry there is nothing to animate.
		if (typeof paths[0].getTotalLength !== "function") return;

		if (prefersReducedMotion()) {
			paths.forEach((path, index) => {
				const point = path.getPointAtLength(path.getTotalLength() * 0.62);
				dots[index].setAttribute("cx", String(point.x));
				dots[index].setAttribute("cy", String(point.y));
				dots[index].setAttribute("opacity", String(PULSE_PEAK));
			});
			return;
		}

		const cycle = PULSE_TRAVEL_MS + PULSE_GAP_MS;
		const lengths = paths.map((path) => path.getTotalLength());
		let raf = 0;
		let origin: number | null = null;

		function frame(now: number) {
			if (origin === null) origin = now;
			const elapsed = now - origin;
			paths.forEach((path, index) => {
				const dot = dots[index];
				const local = elapsed - index * PULSE_STAGGER_MS;
				if (local < 0) return;
				const progress = (local % cycle) / PULSE_TRAVEL_MS;
				if (progress > 1) {
					dot.setAttribute("opacity", "0");
					return;
				}
				const point = path.getPointAtLength(progress * lengths[index]);
				const fade =
					progress < PULSE_FADE
						? progress / PULSE_FADE
						: progress > 1 - PULSE_FADE
							? (1 - progress) / PULSE_FADE
							: 1;
				dot.setAttribute("cx", String(point.x));
				dot.setAttribute("cy", String(point.y));
				dot.setAttribute("opacity", String(fade * PULSE_PEAK));
			});
			raf = requestAnimationFrame(frame);
		}

		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, [svgRef, wires]);
}

/**
 * An orthogonal bracket from the hub's right edge to each leg's left edge. Drawn
 * from whichever end the message left, so the travelling dot runs in the
 * message's own direction without the pulse loop knowing about direction at all.
 */
function bracketPath(hub: { x: number; y: number }, leg: { x: number; y: number }, inbound: boolean): string {
	const mid = (hub.x + leg.x) / 2;
	return inbound
		? `M${leg.x} ${leg.y} H${mid} V${hub.y} H${hub.x}`
		: `M${hub.x} ${hub.y} H${mid} V${leg.y} H${leg.x}`;
}

interface BracketRefs {
	hub: React.MutableRefObject<HTMLElement | null>;
	legs: React.MutableRefObject<(HTMLElement | null)[]>;
	inbound: React.MutableRefObject<boolean[]>;
}

/** Wires are measured from the laid-out DOM: the composition stays ordinary flow layout. */
function useWires(containerRef: React.RefObject<HTMLDivElement | null>, refs: BracketRefs, revision: number): Wire[] {
	const [wires, setWires] = useState<Wire[]>([]);
	const refsRef = useRef(refs);
	refsRef.current = refs;

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		function measure(): void {
			const root = containerRef.current;
			const hub = refsRef.current.hub.current;
			if (!root || !hub) return;
			const base = root.getBoundingClientRect();
			const hubBox = hub.getBoundingClientRect();
			if (!base.width || !hubBox.width) return;
			const hubPoint = { x: hubBox.right - base.left, y: hubBox.top + hubBox.height / 2 - base.top };
			const next: Wire[] = [];
			refsRef.current.legs.current.forEach((node, index) => {
				if (!node) return;
				const legBox = node.getBoundingClientRect();
				const inbound = refsRef.current.inbound.current[index] ?? true;
				const legPoint = { x: legBox.left - base.left, y: legBox.top + legBox.height / 2 - base.top };
				next.push({ d: bracketPath(hubPoint, legPoint, inbound), inbound });
			});
			setWires((previous) =>
				previous.length === next.length && previous.every((wire, i) => wire.d === next[i].d) ? previous : next,
			);
		}

		measure();
		if (typeof ResizeObserver !== "function") return;
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [containerRef, revision]);

	return wires;
}

/** A task box: the smallest thing that still reads as a card from the board. */
function TaskBox({
	endpoint,
	count,
	inbound,
	hub,
	label,
	elementRef,
}: {
	endpoint: Endpoint;
	count?: number;
	inbound?: boolean;
	hub?: boolean;
	label: string;
	elementRef?: (node: HTMLElement | null) => void;
}) {
	const tone = hub ? "text-agent" : inbound ? "text-success" : "text-agent";
	const surface = hub ? "bg-agent/15 ring-agent/60" : "bg-raised ring-edge";
	const inner = (
		<>
			<span className="flex items-center gap-1">
				<span className={`font-mono text-micro ${tone}`}>#{endpoint.seq}</span>
				{count !== undefined && count > 1 && (
					<span className="ml-auto rounded bg-elevated px-1 text-micro text-fg-muted">×{count}</span>
				)}
			</span>
			{endpoint.title && <span className="line-clamp-2 text-micro leading-tight text-fg-3">{endpoint.title}</span>}
		</>
	);
	const shape = `relative z-[1] flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left ring-1 ${surface}`;
	if (!endpoint.onOpen) {
		return (
			<div ref={elementRef} title={endpoint.title} className={shape}>
				{inner}
			</div>
		);
	}
	return (
		<button
			ref={elementRef}
			type="button"
			title={endpoint.title}
			aria-label={label}
			onMouseDown={(event) => event.preventDefault()}
			onClick={endpoint.onOpen}
			className={`${shape} cursor-pointer transition-[background-color,transform] duration-150 hover:bg-raised-hover active:scale-[0.96]`}
		>
			{inner}
		</button>
	);
}

/**
 * The body of an agent-traffic toast: the hub on the left, its counterparts on
 * the right split into what came in and what went out, and the message text in
 * the channel between them. One message is the same composition with one leg.
 */
export function AgentMessageToast({ group }: { group: AgentToastGroup }) {
	const t = useT();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const svgRef = useRef<SVGSVGElement | null>(null);
	const hubRef = useRef<HTMLElement | null>(null);
	const legRefs = useRef<(HTMLElement | null)[]>([]);
	const legInbound = useRef<boolean[]>([]);

	const hub = hubOf(group);
	const legs = hub ? legsOf(group, hub.taskId) : [];
	const received = legs.filter((leg) => leg.inbound).slice(0, MAX_AGENT_LEGS);
	const sent = legs.filter((leg) => !leg.inbound).slice(0, MAX_AGENT_LEGS);
	const hidden = legs.length - received.length - sent.length;
	const shown = [...received, ...sent];

	legRefs.current.length = shown.length;
	legInbound.current = shown.map((leg) => leg.inbound);

	const wires = useWires(containerRef, { hub: hubRef, legs: legRefs, inbound: legInbound }, shown.length);
	usePulses(svgRef, wires);

	if (!hub) return null;

	function block(title: string, rows: Leg[], offset: number) {
		return (
			<div className="flex flex-col gap-1">
				<div className="text-micro uppercase tracking-wide text-fg-muted">{title}</div>
				{rows.map((leg, index) => (
					<div
						key={`${leg.endpoint.taskId}:${leg.inbound ? "in" : "out"}`}
						ref={(node) => {
							legRefs.current[offset + index] = node;
						}}
						className="relative z-[1] flex items-center gap-1.5"
					>
						<span
							title={leg.preview}
							className="min-w-0 flex-1 truncate rounded-md bg-raised px-1.5 py-1 text-micro text-fg"
						>
							<span className={`mr-1 ${leg.inbound ? "text-success" : "text-agent"}`}>
								{leg.inbound ? "←" : "→"}
							</span>
							{leg.preview}
						</span>
						<div className="w-[8rem] shrink-0">
							<TaskBox
								endpoint={leg.endpoint}
								count={leg.count}
								inbound={leg.inbound}
								label={t(leg.inbound ? "toast.agent.openSenderNode" : "toast.agent.openReceiverNode", {
									seq: String(leg.endpoint.seq),
									preview: leg.preview,
								})}
							/>
						</div>
					</div>
				))}
			</div>
		);
	}

	return (
		<div ref={containerRef} className="relative flex min-w-0 flex-1 items-center">
			<svg
				ref={svgRef}
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
			>
				{wires.map((wire, index) => (
					<path
						key={`w${index}`}
						data-wire
						d={wire.d}
						fill="none"
						strokeWidth={1.5}
						strokeLinecap="round"
						className={wire.inbound ? "stroke-success/45" : "stroke-agent/45"}
					/>
				))}
				{wires.map((wire, index) => (
					<circle
						key={`p${index}`}
						data-pulse
						r={2.7}
						opacity={0}
						className={wire.inbound ? "fill-success" : "fill-agent"}
					/>
				))}
			</svg>
			<div className="w-[7rem] shrink-0">
				<TaskBox
					endpoint={hub.endpoint}
					hub
					elementRef={(node) => {
						hubRef.current = node;
					}}
					label={t("toast.agent.openTask", { seq: String(hub.endpoint.seq), title: hub.endpoint.title ?? "" }).trim()}
				/>
			</div>
			{/* Room for the bracket. The wires are absolutely positioned, so the gap
			    has to be reserved by something with width. */}
			<div aria-hidden="true" className="w-8 shrink-0" />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				{received.length > 0 && block(t("toast.agent.groupReceived"), received, 0)}
				{sent.length > 0 && block(t("toast.agent.groupSent"), sent, received.length)}
				{hidden > 0 && <div className="text-micro text-fg-muted">{t("toast.agent.more", { count: String(hidden) })}</div>}
			</div>
		</div>
	);
}
