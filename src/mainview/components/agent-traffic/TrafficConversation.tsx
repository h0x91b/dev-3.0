import { useEffect, useMemo, useRef, useState } from "react";
import { CONVERSATION_SOURCE_LABELS } from "../../../shared/conversation-import-model";
import {
	TASK_CONVERSATION_TEXT_LIMIT,
	clipMarkdown,
	type TaskConversationView,
} from "../../../shared/task-conversation-model";
import { CommentMarkdown } from "../pr-review/markdown";
import { api } from "../../rpc";
import { useT } from "../../i18n";

/**
 * The selected task's own agent conversation, inside the traffic inspector.
 *
 * The other two tabs show traffic *between* agents; this one shows what one agent
 * and its human actually said, which is a different record and is never mixed in
 * with the messages list. It stays a reader: bounded by design (newest page of
 * turns, long messages folded behind "Show more", tool calls counted rather
 * than replayed), with no way to send anything from here.
 *
 * Every read is a file read on the host, so two rules hold the cost down: a
 * request is debounced, and a response that arrives for a task or session the
 * user has already left is dropped rather than rendered under the new heading.
 */

/** Arrowing through nodes must not queue one host-side parse per node. */
const REQUEST_DEBOUNCE_MS = 250;

/**
 * One message, rendered as the Markdown the agent actually wrote — the same safe
 * renderer the PR review surface uses, so raw HTML stays off and links go through
 * the shared hardener.
 *
 * Long ones open in place: the whole text is already here, so the button costs a
 * re-render and no round trip. The folded half is cut on a Markdown boundary
 * (`clipMarkdown`), never at a character index, so a half-open fence or table can
 * neither render as garbage nor spill the hidden half as prose.
 */
function Message({ who, text, tone }: { who: string; text: string; tone: "user" | "agent" }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const long = text.length > TASK_CONVERSATION_TEXT_LIMIT;
	const preview = useMemo(() => clipMarkdown(text), [text]);
	return (
		<div className={`traffic-turn-${tone} streamer-private`}>
			<b>{who}</b>
			<div className="traffic-turn-body">
				<CommentMarkdown body={open || !long ? text : preview.text} />
			</div>
			{long && (
				<button className="traffic-turn-more" onClick={() => setOpen((value) => !value)}>
					{t(open ? "traffic.conversation.showLess" : "traffic.conversation.showMore")}
				</button>
			)}
		</div>
	);
}

interface TrafficConversationProps {
	projectId: string | null;
	taskId: string | null;
	/** A node with no live task behind it: nothing to read, and we say so. */
	taskGone?: boolean;
	format: (iso: string) => string;
}

function TrafficConversation({ projectId, taskId, taskGone, format }: TrafficConversationProps) {
	const t = useT();
	const [view, setView] = useState<TaskConversationView | null>(null);
	const [sessionKey, setSessionKey] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	/** What the user is looking at right now — the test every response must pass. */
	const showing = useRef<string>("");
	showing.current = `${projectId}/${taskId}`;

	// Selecting another task drops whatever was on screen: a stale transcript under
	// a new heading is the one mistake this panel must never make.
	useEffect(() => {
		setView(null);
		setSessionKey(null);
	}, [taskId, projectId]);

	useEffect(() => {
		if (!projectId || !taskId) return;
		let live = true;
		const asked = `${projectId}/${taskId}`;
		setFailed(false);
		const timer = setTimeout(() => {
			setLoading(true);
			api.request
				.readTaskConversation({ projectId, taskId, sessionKey })
				.then((result) => {
					if (!live || showing.current !== asked) return;
					setView(result);
					setLoading(false);
				})
				.catch(() => {
					if (!live || showing.current !== asked) return;
					setFailed(true);
					setLoading(false);
				});
		}, REQUEST_DEBOUNCE_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [projectId, taskId, sessionKey]);

	const loadEarlier = () => {
		if (!projectId || !taskId || !view || loading) return;
		const asked = `${projectId}/${taskId}`;
		const askedSession = view.sessionKey;
		setLoading(true);
		api.request
			.readTaskConversation({ projectId, taskId, sessionKey: askedSession, before: view.firstIndex })
			.then((older) => {
				if (showing.current !== asked) return;
				setView((current) =>
					current && current.sessionKey === askedSession
						? { ...older, turns: [...older.turns, ...current.turns] }
						: current,
				);
				setLoading(false);
			})
			.catch(() => {
				if (showing.current !== asked) return;
				setFailed(true);
				setLoading(false);
			});
	};

	if (!taskId) return <p className="traffic-empty">{t("traffic.conversation.selectTask")}</p>;
	if (taskGone) return <p className="traffic-empty">{t("traffic.conversation.historical")}</p>;
	if (failed) return <p className="traffic-empty">{t("traffic.conversation.failed")}</p>;
	if (!view) return <p className="traffic-empty">{t("traffic.loading")}</p>;
	if (view.sessions.length === 0) return <p className="traffic-empty">{t("traffic.conversation.none")}</p>;

	const session = view.sessions.find((candidate) => candidate.key === view.sessionKey) ?? view.sessions[0];

	return (
		<div className="traffic-conversation">
			<div className="traffic-conversation-head">
				{view.sessions.length > 1 ? (
					<select
						aria-label={t("traffic.conversation.session")}
						value={session.key}
						onChange={(event) => setSessionKey(event.target.value)}
					>
						{view.sessions.map((candidate, position) => (
							<option key={candidate.key} value={candidate.key}>
								{`${CONVERSATION_SOURCE_LABELS[candidate.source]} · ${
									candidate.lastActivityAt ? format(candidate.lastActivityAt) : `#${position + 1}`
								}`}
							</option>
						))}
					</select>
				) : (
					<b>{CONVERSATION_SOURCE_LABELS[session.source]}</b>
				)}
				<span
					className={`traffic-conversation-origin origin-${session.origin}`}
					title={t(
						session.origin === "archived"
							? "traffic.conversation.archivedHelp"
							: "traffic.conversation.liveHelp",
					)}
				>
					{t(session.origin === "archived" ? "traffic.conversation.archived" : "traffic.conversation.live")}
				</span>
				<small>
					{t("traffic.conversation.shown", {
						shown: String(view.turns.length),
						total: String(view.totalTurns),
					})}
					{view.fidelity === "partial" ? ` · ${t("traffic.conversation.partial")}` : ""}
				</small>
			</div>
			{view.firstIndex > 0 && (
				<button className="traffic-conversation-earlier" onClick={loadEarlier} disabled={loading}>
					{t("traffic.conversation.earlier")}
				</button>
			)}
			{view.turns.map((turn) => (
				<article key={turn.index} className="traffic-turn">
					{turn.startedAt && <time>{format(turn.startedAt)}</time>}
					{turn.userText && (
						<Message who={t("traffic.node.you")} text={turn.userText} tone="user" />
					)}
					{turn.actions > 0 && (
						<p className="traffic-turn-actions">
							{t.plural("traffic.conversation.actions", turn.actions)}
							{turn.tools.length > 0 ? ` · ${turn.tools.join(", ")}` : ""}
						</p>
					)}
					{turn.assistantText && (
						<Message
							who={CONVERSATION_SOURCE_LABELS[session.source]}
							text={turn.assistantText}
							tone="agent"
						/>
					)}
					{turn.clippedChars > 0 && (
						<small className="traffic-turn-clamped">
							{t.plural("traffic.conversation.clipped", turn.clippedChars)}
						</small>
					)}
				</article>
			))}
		</div>
	);
}

export default TrafficConversation;
