import { useEffect, useState } from "react";
import { CONVERSATION_SOURCE_LABELS } from "../../../shared/conversation-import-model";
import type { TaskConversationView } from "../../../shared/task-conversation-model";
import { api } from "../../rpc";
import { useT } from "../../i18n";

/**
 * The selected task's own agent conversation, inside the traffic inspector.
 *
 * The other two tabs show traffic *between* agents; this one shows what one agent
 * and its human actually said, which is a different record and is never mixed in
 * with the messages list. It stays a reader: bounded by design (newest page of
 * turns, each message clamped, tool calls counted rather than replayed), with no
 * way to send anything from here — the traffic screen owns no composer.
 */

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

	// Selecting another task drops whatever was on screen: a stale transcript under
	// a new heading is the one mistake this panel must never make.
	useEffect(() => {
		setView(null);
		setSessionKey(null);
	}, [taskId, projectId]);

	useEffect(() => {
		if (!projectId || !taskId) return;
		let live = true;
		setLoading(true);
		setFailed(false);
		api.request
			.readTaskConversation({ projectId, taskId, sessionKey })
			.then((result) => {
				if (!live) return;
				setView(result);
				setLoading(false);
			})
			.catch(() => {
				if (!live) return;
				setFailed(true);
				setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [projectId, taskId, sessionKey]);

	const loadEarlier = () => {
		if (!projectId || !taskId || !view) return;
		setLoading(true);
		api.request
			.readTaskConversation({ projectId, taskId, sessionKey: view.sessionKey, before: view.firstIndex })
			.then((older) => {
				setView((current) =>
					current
						? { ...older, turns: [...older.turns, ...current.turns] }
						: older,
				);
				setLoading(false);
			})
			.catch(() => {
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
	const shown = view.turns.length;

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
									candidate.endedAt ? format(candidate.endedAt) : `#${position + 1}`
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
					{t("traffic.conversation.shown", { shown: String(shown), total: String(view.totalTurns) })}
					{session.fidelity === "partial" ? ` · ${t("traffic.conversation.partial")}` : ""}
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
						<div className="traffic-turn-user streamer-private">
							<b>{t("traffic.node.you")}</b>
							<p>{turn.userText}</p>
						</div>
					)}
					{turn.actions > 0 && (
						<p className="traffic-turn-actions">
							{t.plural("traffic.conversation.actions", turn.actions)}
							{turn.tools.length > 0 ? ` · ${turn.tools.join(", ")}` : ""}
						</p>
					)}
					{turn.assistantText && (
						<div className="traffic-turn-agent streamer-private">
							<b>{CONVERSATION_SOURCE_LABELS[session.source]}</b>
							<p>{turn.assistantText}</p>
						</div>
					)}
					{turn.clamped && <small className="traffic-turn-clamped">{t("traffic.conversation.clamped")}</small>}
				</article>
			))}
		</div>
	);
}

export default TrafficConversation;
