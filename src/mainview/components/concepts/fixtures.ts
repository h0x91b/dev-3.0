/**
 * Throwaway fixture data for the agent-message concept gallery.
 *
 * Concept scaffolding only: strings here are deliberately NOT routed through
 * `t()`. They stand in for agent-authored bodies and task titles, which are user
 * data rather than UI copy; the six concepts are for looking at, not shipping.
 */

export interface ConceptTask {
	seq: number;
	title: string;
	/** Drives the identity rail colour, mirroring STATUS_COLORS semantics. */
	tone: "coordinator" | "working" | "review" | "questions";
}

export interface ConceptMessage {
	id: number;
	from: ConceptTask;
	to: ConceptTask;
	body: string;
	/** Minutes ago. */
	ago: number;
	/** Only concept 6 acts on this; nothing produces it today. */
	urgent?: boolean;
}

export const COORDINATOR: ConceptTask = { seq: 1141, title: "Coordinate the message-display work", tone: "coordinator" };

export const WORKERS: ConceptTask[] = [
	{ seq: 1660, title: "Design six ways to show a message", tone: "working" },
	{ seq: 1648, title: "Concept: 3D space for message flow", tone: "review" },
	{ seq: 1652, title: "Append-only agent message log", tone: "questions" },
	{ seq: 1631, title: "Windows native terminal backend", tone: "questions" },
];

export const TONE_COLOR: Record<ConceptTask["tone"], string> = {
	coordinator: "rgb(var(--success))",
	working: "rgb(var(--accent))",
	review: "rgb(var(--agent))",
	questions: "rgb(var(--warning))",
};

export const MESSAGES: ConceptMessage[] = [
	{ id: 1, from: COORDINATOR, to: WORKERS[0], body: "Six concepts, screenshot each one, dark and light.", ago: 1 },
	{ id: 2, from: WORKERS[0], to: COORDINATOR, body: "Started. UX pass first, then the gallery route.", ago: 3 },
	{ id: 3, from: WORKERS[1], to: COORDINATOR, body: "Problem statement is in a note on my task.", ago: 8 },
	{ id: 4, from: COORDINATOR, to: WORKERS[2], body: "Rebase on main — the log RPC landed there.", ago: 14 },
	{
		id: 5,
		from: WORKERS[2],
		to: WORKERS[0],
		body: "I am editing src/mainview/toast.tsx right now. Stay off it.",
		ago: 16,
		urgent: true,
	},
	{ id: 6, from: COORDINATOR, to: WORKERS[3], body: "test 4", ago: 22 },
	{ id: 7, from: COORDINATOR, to: WORKERS[3], body: "test 5", ago: 23 },
	{ id: 8, from: WORKERS[3], to: COORDINATOR, body: "Windows shard is green, aggregate pending.", ago: 41 },
];

export function shortTitle(task: ConceptTask, max = 22): string {
	return task.title.length > max ? `${task.title.slice(0, max - 1)}…` : task.title;
}

export function agoLabel(minutes: number): string {
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.round(minutes / 60)}h`;
}
