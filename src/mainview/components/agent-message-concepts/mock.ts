/**
 * Throwaway concept scaffolding (see `AgentMessageConceptGallery`). All strings
 * here are hardcoded English on purpose: this data exists only to render six
 * competing designs for a screenshot, and none of it ships.
 */

/**
 * Importance. NOT a field the `agentMessage` push carries today — a sender has
 * no way to say "this one matters". Concepts that use it are proposing it.
 */
export type Weight = "chatter" | "normal" | "blocker";

export interface ConceptMessage {
	id: number;
	fromSeq: number;
	fromTitle: string;
	toSeq: number;
	toTitle: string;
	text: string;
	/** How long ago it landed, human-ready. */
	ago: string;
	weight: Weight;
}

/** One live pair, i.e. the STATE the traffic adds up to. */
export interface ConceptPair {
	id: number;
	aSeq: number;
	aTitle: string;
	bSeq: number;
	bTitle: string;
	/** Which way the last message went. */
	dir: "a-to-b" | "b-to-a";
	count: number;
	ago: string;
	/** How long the party that owes an answer has been silent. */
	waiting?: string;
	weight: Weight;
	last: string;
}

export const MESSAGES: ConceptMessage[] = [
	{
		id: 1,
		fromSeq: 1141,
		fromTitle: "Coordinate the message-display redesign",
		toSeq: 1660,
		toTitle: "Design six ways to show an agent message",
		text: "Rebase on origin/main before you push — 1505 is closed, not merged.",
		ago: "just now",
		weight: "normal",
	},
	{
		id: 2,
		fromSeq: 1503,
		fromTitle: "Windows packaging shard",
		toSeq: 1141,
		toTitle: "Coordinate the message-display redesign",
		text: "Blocked: you are editing src/mainview/toast.tsx and so am I.",
		ago: "2m",
		weight: "blocker",
	},
	{
		id: 3,
		fromSeq: 1648,
		fromTitle: "Re-state the agent-traffic problem",
		toSeq: 1141,
		toTitle: "Coordinate the message-display redesign",
		text: "Statement is in the task notes. Six points, no code.",
		ago: "6m",
		weight: "normal",
	},
	{
		id: 4,
		fromSeq: 1141,
		fromTitle: "Coordinate the message-display redesign",
		toSeq: 1503,
		toTitle: "Windows packaging shard",
		text: "test 3",
		ago: "9m",
		weight: "chatter",
	},
	{
		id: 5,
		fromSeq: 1610,
		fromTitle: "Landing page walkthrough",
		toSeq: 1141,
		toTitle: "Coordinate the message-display redesign",
		text: "Head sha 9f21ac0, follow-up commit, CI aggregate green.",
		ago: "14m",
		weight: "normal",
	},
];

export const PAIRS: ConceptPair[] = [
	{
		id: 1,
		aSeq: 1503,
		aTitle: "Windows packaging shard",
		bSeq: 1141,
		bTitle: "Coordinate the message-display redesign",
		dir: "a-to-b",
		count: 4,
		ago: "2m",
		waiting: "2m",
		weight: "blocker",
		last: "Blocked: you are editing src/mainview/toast.tsx and so am I.",
	},
	{
		id: 2,
		aSeq: 1141,
		aTitle: "Coordinate the message-display redesign",
		bSeq: 1660,
		bTitle: "Design six ways to show an agent message",
		dir: "a-to-b",
		count: 2,
		ago: "just now",
		weight: "normal",
		last: "Rebase on origin/main before you push.",
	},
	{
		id: 3,
		aSeq: 1648,
		aTitle: "Re-state the agent-traffic problem",
		bSeq: 1141,
		bTitle: "Coordinate the message-display redesign",
		dir: "a-to-b",
		count: 1,
		ago: "6m",
		weight: "normal",
		last: "Statement is in the task notes.",
	},
	{
		id: 4,
		aSeq: 1610,
		aTitle: "Landing page walkthrough",
		bSeq: 1141,
		bTitle: "Coordinate the message-display redesign",
		dir: "a-to-b",
		count: 7,
		ago: "14m",
		waiting: "14m",
		weight: "chatter",
		last: "test 5",
	},
];

/** Token class for a weight — the whole importance axis in one place. */
export const WEIGHT_DOT: Record<Weight, string> = {
	chatter: "bg-fg-muted/50",
	normal: "bg-agent",
	blocker: "bg-danger",
};

export const WEIGHT_TEXT: Record<Weight, string> = {
	chatter: "text-fg-muted",
	normal: "text-agent",
	blocker: "text-danger",
};
