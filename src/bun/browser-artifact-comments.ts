import type { Project, SharedArtifact, Task } from "../shared/types";
import { TERMINAL_STATUSES } from "../shared/types";
import { liveEntryId } from "../shared/live-artifact";
import { artifactAtVersion, latestArtifactVersion } from "../shared/artifact-versions";
import {
	appendReviewComment,
	buildReviewPrompt,
	markReviewCommentsSent,
	REVIEW_ANCHOR_TEXT_LIMIT,
	reviewCommentsForArtifact,
	type ReviewComment,
} from "../shared/review";
import type { ArtifactCommentPin } from "../shared/artifact-comment-script";
import { LiveOpError, type LiveAgentSender } from "./live-artifact-ops";
import * as data from "./data";

/**
 * Comments made on an artifact opened in a browser tab, live or static. They
 * land on the task review exactly like the viewer's comment mode, so the app
 * draws the same pins and the agent gets the same `<reviews>` prompt.
 */

/** Which page a tab shows: the task's live page, or one version of a shared artifact. */
export type BrowserArtifactRef = { kind: "live" } | { kind: "static"; id: string; version: number };

export interface BrowserArtifactTarget {
	/** The page record to serve; a static ref resolves to that version's files. */
	page: SharedArtifact;
	/** `ReviewArtifactElementAnchor.artifactId` / `version` — the pins' identity. */
	artifactId: string;
	version: number;
}

export interface BrowserCommentInput {
	selector: string;
	text: string;
	heading: string | null;
	body: string;
	/** Hand it to the agent now, or only keep it on the review. */
	send: boolean;
}

export type TaskPush = ((event: string, payload: unknown) => void) | null | undefined;

const SELECTOR_LIMIT = 1_000;
const BODY_LIMIT = 10_000;

export function resolveBrowserArtifact(task: Task, ref: BrowserArtifactRef): BrowserArtifactTarget | null {
	if (ref.kind === "live") {
		return task.liveArtifact ? { page: task.liveArtifact.page, artifactId: liveEntryId(task.id), version: 1 } : null;
	}
	const group = (task.sharedArtifacts ?? []).find((artifact) => artifact.id === ref.id);
	if (!group) return null;
	const latest = latestArtifactVersion(group);
	const known = ref.version === latest || (group.previousVersions ?? []).some((entry) => entry.version === ref.version);
	if (!known) return null;
	return { page: artifactAtVersion(group, ref.version), artifactId: group.id, version: ref.version };
}

/** The ref a tab sends with each call: absent means the live page. */
export function parseBrowserArtifactRef(value: unknown): BrowserArtifactRef {
	if (!value || typeof value !== "object") return { kind: "live" };
	const { id, version } = value as { id?: unknown; version?: unknown };
	if (typeof id !== "string" || !Number.isInteger(version)) throw new LiveOpError("Invalid artifact reference", "invalid");
	return { kind: "static", id, version: version as number };
}

function str(value: unknown, limit: number): string {
	return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function parseBrowserCommentInput(args: Record<string, unknown>): BrowserCommentInput {
	const body = str(args.body, BODY_LIMIT);
	if (!body) throw new LiveOpError("Write what should change first", "invalid");
	const selector = str(args.selector, SELECTOR_LIMIT);
	if (!selector) throw new LiveOpError("Pick an element first", "invalid");
	return {
		selector,
		text: str(args.text, REVIEW_ANCHOR_TEXT_LIMIT),
		heading: str(args.heading, REVIEW_ANCHOR_TEXT_LIMIT) || null,
		body,
		send: args.send === true,
	};
}

/** A pin plus its text, so the tab can show the comment without a second request. */
export type BrowserPin = ArtifactCommentPin & { body: string };

/** The pins a tab draws for one artifact version, numbered like the viewer's. */
export function browserPins(task: Task, target: BrowserArtifactTarget): BrowserPin[] {
	return reviewCommentsForArtifact(task.review, target.artifactId)
		.filter((comment) => comment.anchor.kind === "artifact-element" && comment.anchor.version === target.version)
		.map((comment, i) => {
			const anchor = comment.anchor.kind === "artifact-element" ? comment.anchor : null;
			return {
				id: comment.id,
				n: i + 1,
				selector: anchor?.selector ?? "",
				text: anchor?.text ?? "",
				heading: anchor?.heading ?? null,
				resolved: Boolean(comment.resolvedAt),
				active: false,
				body: comment.body,
			};
		});
}

export async function addBrowserComment(
	project: Project,
	task: Task,
	target: BrowserArtifactTarget,
	input: BrowserCommentInput,
	deps: { sendToAgent: LiveAgentSender; push: TaskPush },
): Promise<{ id: string; sent: boolean }> {
	if (TERMINAL_STATUSES.includes(task.status)) {
		throw new LiveOpError(`task is ${task.status}; its artifacts are read-only`, "read-only");
	}
	const comment: ReviewComment = {
		id: crypto.randomUUID(),
		body: input.body,
		createdAt: new Date().toISOString(),
		anchor: {
			kind: "artifact-element",
			artifactId: target.artifactId,
			version: target.version,
			title: target.page.title,
			selector: input.selector,
			text: input.text,
			heading: input.heading,
		},
	};
	const saved = await data.updateTaskWith(project, task.id, (current) => ({
		updates: { review: appendReviewComment(current.review, comment) },
		result: undefined,
	}));
	deps.push?.("taskUpdated", { projectId: project.id, task: saved.task });
	if (!input.send) return { id: comment.id, sent: false };

	const text = buildReviewPrompt([{ id: comment.id, anchor: comment.anchor, comment: comment.body, origin: "local", author: null }]);
	try {
		await deps.sendToAgent(saved.task, text);
	} catch (error) {
		throw new LiveOpError(`Saved, but not sent: ${error instanceof Error ? error.message : String(error)}`, "failed");
	}
	const sent = await data.updateTaskWith(project, task.id, (current) => ({
		updates: { review: markReviewCommentsSent(current.review ?? [], [comment.id]) },
		result: undefined,
	}));
	deps.push?.("taskUpdated", { projectId: project.id, task: sent.task });
	return { id: comment.id, sent: true };
}
