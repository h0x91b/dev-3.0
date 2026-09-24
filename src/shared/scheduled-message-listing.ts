import type { ScheduledMessage } from "./types";

const PREVIEW_CHARS = 160;

/** One pending scheduled message as `dev3 message --list [--json]` shows it. Additive only. */
export interface ScheduledMessageListing {
	id: string;
	/** ISO instant, UTC. */
	at: string;
	subject: string | null;
	target: "agent" | "pane";
	/** The sending task's seq, or null when a human queued it. */
	fromSeq: number | null;
	fromTaskId: string | null;
	/** Start of the body — the full text can be large and is not needed to pick one. */
	preview: string;
}

export function toScheduledMessageListing(messages: ScheduledMessage[]): ScheduledMessageListing[] {
	return [...messages]
		.sort((a, b) => a.at.localeCompare(b.at))
		.map((m) => {
			const flat = m.text.replace(/\s+/g, " ").trim();
			return {
				id: m.id,
				at: m.at,
				subject: m.subject ?? null,
				target: m.target?.kind === "pane" ? "pane" : "agent",
				fromSeq: m.source?.seq ?? null,
				fromTaskId: m.source?.taskId ?? null,
				preview: flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat,
			};
		});
}
