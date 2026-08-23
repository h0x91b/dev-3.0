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
 * A single message has no hub and renders as a plain pair instead.
 */
export interface AgentToastGroup {
	items: AgentToastItem[];
	hubTaskId?: string;
}

/** Nodes drawn per direction before the rest collapse into a "+N" row. */
export const MAX_AGENT_NODES = 4;

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
	if (mine.has(first.fromTaskId)) return first.fromTaskId;
	if (mine.has(first.toTaskId)) return first.toTaskId;
	return undefined;
}

/** Endpoint identity of the hub, taken from whichever message names it. */
function hubEndpoint(group: AgentToastGroup): Endpoint | undefined {
	if (!group.hubTaskId) return undefined;
	for (const { link } of group.items) {
		if (link.fromTaskId === group.hubTaskId) return sender(link);
		if (link.toTaskId === group.hubTaskId) return receiver(link);
	}
	return undefined;
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

/** Cubic wire from one box edge to another, flat at both ends so it leaves horizontally. */
function wirePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
	const mid = (from.x + to.x) / 2;
	return `M${from.x} ${from.y} C${mid} ${from.y} ${mid} ${to.y} ${to.x} ${to.y}`;
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

interface GraphBoxes {
	hub: React.MutableRefObject<HTMLElement | null>;
	inbound: React.MutableRefObject<(HTMLElement | null)[]>;
	outbound: React.MutableRefObject<(HTMLElement | null)[]>;
}

/** Wires are measured from the laid-out DOM: the graph stays ordinary flow layout. */
function useWires(containerRef: React.RefObject<HTMLDivElement | null>, boxes: GraphBoxes, revision: number): Wire[] {
	const [wires, setWires] = useState<Wire[]>([]);
	const boxesRef = useRef(boxes);
	boxesRef.current = boxes;

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		function measure(): void {
			const root = containerRef.current;
			const hub = boxesRef.current.hub.current;
			if (!root || !hub) return;
			const base = root.getBoundingClientRect();
			const hubBox = hub.getBoundingClientRect();
			if (!base.width || !hubBox.width) return;
			const next: Wire[] = [];
			const legs: { nodes: (HTMLElement | null)[]; inbound: boolean }[] = [
				{ nodes: boxesRef.current.inbound.current, inbound: true },
				{ nodes: boxesRef.current.outbound.current, inbound: false },
			];
			for (const leg of legs) {
				for (const node of leg.nodes) {
					if (!node) continue;
					const nodeBox = node.getBoundingClientRect();
					const hubPoint = {
						x: (leg.inbound ? hubBox.left : hubBox.right) - base.left,
						y: hubBox.top + hubBox.height / 2 - base.top,
					};
					const nodePoint = {
						x: (leg.inbound ? nodeBox.right : nodeBox.left) - base.left,
						y: nodeBox.top + nodeBox.height / 2 - base.top,
					};
					next.push({
						d: leg.inbound ? wirePath(nodePoint, hubPoint) : wirePath(hubPoint, nodePoint),
						inbound: leg.inbound,
					});
				}
			}
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

function NodeButton({
	endpoint,
	preview,
	inbound,
	label,
	showPreview,
	elementRef,
}: {
	endpoint: Endpoint;
	preview: string;
	inbound: boolean;
	label: string;
	/** False when both directions share the width: a 5-character stub reads as broken. */
	showPreview: boolean;
	elementRef: (node: HTMLElement | null) => void;
}) {
	const tone = inbound ? "text-success" : "text-agent";
	const content = (
		<>
			<span className={`font-mono text-micro ${tone} flex-shrink-0`}>#{endpoint.seq}</span>
			{showPreview && <span className="truncate text-fg-2">{preview}</span>}
		</>
	);
	if (!endpoint.onOpen) {
		return (
			<div
				ref={elementRef}
				title={preview}
				className="relative flex items-center gap-1.5 rounded-md bg-raised px-1.5 py-1 text-micro min-w-0"
			>
				{content}
			</div>
		);
	}
	return (
		<button
			ref={elementRef}
			type="button"
			title={preview}
			aria-label={label}
			onMouseDown={(event) => event.preventDefault()}
			onClick={endpoint.onOpen}
			className="relative flex items-center gap-1.5 rounded-md bg-raised px-1.5 py-1 text-micro min-w-0 text-left transition-[background-color,transform] duration-150 hover:bg-raised-hover active:scale-[0.96] cursor-pointer"
		>
			{content}
		</button>
	);
}

/** The graph: hub on one side (or in the middle), its counterparts on the other. */
function AgentGraph({ group, hub }: { group: AgentToastGroup; hub: Endpoint }) {
	const t = useT();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const svgRef = useRef<SVGSVGElement | null>(null);
	const hubRef = useRef<HTMLElement | null>(null);
	const inboundRefs = useRef<(HTMLElement | null)[]>([]);
	const outboundRefs = useRef<(HTMLElement | null)[]>([]);

	const outgoing = group.items.filter(({ link }) => link.fromTaskId === group.hubTaskId);
	const incoming = group.items.filter(({ link }) => link.toTaskId === group.hubTaskId);
	const shownOut = outgoing.slice(0, MAX_AGENT_NODES);
	const shownIn = incoming.slice(0, MAX_AGENT_NODES);
	const hiddenCount = outgoing.length - shownOut.length + (incoming.length - shownIn.length);
	const mode = outgoing.length && incoming.length ? "both" : outgoing.length ? "out" : "in";

	inboundRefs.current.length = shownIn.length;
	outboundRefs.current.length = shownOut.length;

	const wires = useWires(containerRef, { hub: hubRef, inbound: inboundRefs, outbound: outboundRefs }, group.items.length);
	usePulses(svgRef, wires);

	const hubNode = (
		<button
			ref={(node) => {
				hubRef.current = node;
			}}
			type="button"
			onMouseDown={(event) => event.preventDefault()}
			onClick={hub.onOpen}
			disabled={!hub.onOpen}
			aria-label={t("toast.agent.openTask", { seq: String(hub.seq), title: hub.title ?? "" }).trim()}
			title={hub.title}
			className="relative z-[1] flex w-[5.5rem] flex-col gap-0.5 rounded-lg bg-agent/15 px-2 py-1.5 text-left ring-1 ring-agent/60 transition-[background-color,transform] duration-150 enabled:hover:bg-agent/25 enabled:active:scale-[0.96] enabled:cursor-pointer"
		>
			<span className="font-mono text-micro text-agent">#{hub.seq}</span>
			{hub.title && <span className="text-micro text-fg-3 line-clamp-2 leading-tight">{hub.title}</span>}
		</button>
	);

	function column(items: AgentToastItem[], inbound: boolean) {
		const refs = inbound ? inboundRefs : outboundRefs;
		return (
			<div className={`relative z-[1] flex flex-col gap-1 ${mode === "both" ? "shrink-0" : "min-w-0 flex-1"}`}>
				{items.map((item, index) => {
					const endpoint = inbound ? sender(item.link) : receiver(item.link);
					return (
						<NodeButton
							key={item.id}
							endpoint={endpoint}
							preview={item.preview}
							inbound={inbound}
							showPreview={mode !== "both"}
							label={t(inbound ? "toast.agent.openSenderNode" : "toast.agent.openReceiverNode", {
								seq: String(endpoint.seq),
								preview: item.preview,
							})}
							elementRef={(node) => {
								refs.current[index] = node;
							}}
						/>
					);
				})}
			</div>
		);
	}

	const footer =
		mode === "both"
			? t("toast.agent.mixedCount", { out: String(outgoing.length), in: String(incoming.length) })
			: mode === "out"
				? t("toast.agent.sentCount", { count: String(outgoing.length) })
				: t("toast.agent.receivedCount", { count: String(incoming.length) });

	return (
		<div className="min-w-0 flex-1">
			<div ref={containerRef} className={`relative flex items-center gap-3 ${mode === "both" ? "justify-center" : ""}`}>
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
				{mode !== "out" && column(shownIn, true)}
				{hubNode}
				{mode !== "in" && column(shownOut, false)}
			</div>
			<div className="mt-1.5 flex items-center justify-between gap-2 text-micro text-fg-muted">
				<span>{footer}</span>
				{hiddenCount > 0 && <span>{t("toast.agent.more", { count: String(hiddenCount) })}</span>}
			</div>
		</div>
	);
}

/** One message: the two squares the user asked for, with the text underneath. */
function AgentPair({ item }: { item: AgentToastItem }) {
	const t = useT();
	const from = sender(item.link);
	const to = receiver(item.link);

	function square(endpoint: Endpoint, roleLabel: string) {
		const inner = (
			<>
				<span className="text-micro uppercase tracking-wide text-fg-muted">{roleLabel}</span>
				<span className="font-mono text-xs text-agent">#{endpoint.seq}</span>
				{endpoint.title && <span className="text-micro text-fg-3 line-clamp-2 leading-tight">{endpoint.title}</span>}
			</>
		);
		if (!endpoint.onOpen) {
			return <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg bg-raised px-2 py-1.5">{inner}</div>;
		}
		return (
			<button
				type="button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={endpoint.onOpen}
				aria-label={`${roleLabel}: ${t("toast.agent.openTask", { seq: String(endpoint.seq), title: endpoint.title ?? "" }).trim()}`}
				className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-lg bg-raised px-2 py-1.5 text-left ring-1 ring-agent/40 transition-[background-color,transform] duration-150 hover:bg-raised-hover active:scale-[0.96]"
			>
				{inner}
			</button>
		);
	}

	return (
		<div className="min-w-0 flex-1">
			<div className="flex items-stretch gap-2">
				{square(from, t("toast.agent.roleSender"))}
				<span aria-hidden="true" className="self-center text-agent">
					→
				</span>
				{square(to, t("toast.agent.roleReceiver"))}
			</div>
			<p className="mt-2 break-words text-sm leading-relaxed text-fg">{item.preview}</p>
		</div>
	);
}

/**
 * The body of an agent-traffic toast. One message renders as a pair of squares;
 * a burst around one hub renders as a graph, so five identical violet toasts
 * become one card whose shape says who is talking to whom.
 */
export function AgentMessageToast({ group }: { group: AgentToastGroup }) {
	const hub = hubEndpoint(group);
	if (group.items.length === 1 || !hub) return <AgentPair item={group.items[0]} />;
	return <AgentGraph group={group} hub={hub} />;
}
