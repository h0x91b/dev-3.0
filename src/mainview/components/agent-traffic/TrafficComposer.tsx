import { useRef } from "react";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import { isMac } from "../../utils/platform";
import { TERMINAL_STATUSES, type Task } from "../../../shared/types";

/**
 * How much the inspector's composer accepts. It is deliberately a short-message
 * box: anything longer belongs in the task's own terminal, and past
 * {@link AGENT_MESSAGE_SPILL_THRESHOLD_BYTES} the host stops typing the text and
 * hands the agent a file path instead — a shape this surface should not produce
 * on purpose.
 */
export const TRAFFIC_COMPOSER_MAX_CHARS = 1000;

/** Characters left at which the counter appears; silent until the cap is near. */
const COUNTER_VISIBLE_FROM = 100;

export type TrafficComposerPhase = "idle" | "sending" | "sent" | "error";
export interface TrafficComposerState {
	phase: TrafficComposerPhase;
	/** Error text, or the spill path when a send was written to a file. */
	detail?: string;
}

interface Props {
	task: Task;
	projectId: string;
	seqLabel: string;
	draft: string;
	onDraftChange: (next: string) => void;
	state: TrafficComposerState;
	onStateChange: (next: TrafficComposerState) => void;
}

/**
 * A short plain-text message to the selected task's agent, sent without leaving
 * the traffic screen.
 *
 * Deliberately not a terminal: no slash commands, no completion, no history, no
 * file drop. It carries the same user-origin delivery the diff viewer's "Send to
 * agent" uses (`sendAgentMessageNow`), so the row it produces is a real user
 * message — the graph draws it from the `You` endpoint, never as fabricated
 * peer-agent traffic.
 *
 * Nothing here starts or resumes an agent. A task whose session is not running
 * says so before you type, and a send that finds no live pane fails out loud with
 * the text still in the box.
 */
export default function TrafficComposer({
	task,
	projectId,
	seqLabel,
	draft,
	onDraftChange,
	state,
	onStateChange,
}: Props) {
	const t = useT();
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// The board's own verdict, not a guess: the host refuses these outright, so a
	// box that looks usable would be a lie no matter what the pane is doing.
	if (TERMINAL_STATUSES.includes(task.status)) {
		return <p className="traffic-compose-closed">{t("traffic.compose.terminalStatus")}</p>;
	}

	const text = draft.trim();
	const busy = state.phase === "sending";
	const canSend = text.length > 0 && !busy;
	// A hint, never a block. `runtimeState` is a persisted hint the actor verifies
	// against tmux reality, so disabling the button on it would refuse sends that
	// would have landed.
	const quiet = task.runtimeState?.runtime !== "running" || task.hibernated === true;
	const remaining = TRAFFIC_COMPOSER_MAX_CHARS - draft.length;

	function send() {
		if (!canSend) return;
		if (timer.current) clearTimeout(timer.current);
		onStateChange({ phase: "sending" });
		api.request
			.sendAgentMessageNow({ taskId: task.id, projectId, text })
			.then((result) => {
				onDraftChange("");
				onStateChange({ phase: "sent", ...(result?.spilledPath ? { detail: result.spilledPath } : {}) });
				timer.current = setTimeout(() => onStateChange({ phase: "idle" }), 8000);
			})
			.catch((err) => {
				// The text stays in the box: a failed send must never cost the user
				// what they wrote.
				onStateChange({ phase: "error", detail: String(err instanceof Error ? err.message : err) });
			});
	}

	const status =
		state.phase === "error"
			? { tone: "error", text: t("traffic.compose.failed", { error: state.detail ?? "" }) }
			: state.phase === "sent"
				? {
						tone: "sent",
						text: state.detail
							? t("traffic.compose.sentAsFile", { path: state.detail })
							: t("traffic.compose.sent"),
					}
				: quiet
					? { tone: "warn", text: t("traffic.compose.noSession") }
					: { tone: "hint", text: t(isMac() ? "traffic.compose.hintMac" : "traffic.compose.hint") };

	return (
		<div className="traffic-compose" data-testid="traffic-composer">
			<textarea
				className="traffic-compose-input streamer-private"
				value={draft}
				rows={2}
				maxLength={TRAFFIC_COMPOSER_MAX_CHARS}
				disabled={busy}
				aria-label={t("traffic.compose.label", { seq: seqLabel })}
				placeholder={t("traffic.compose.placeholder", { seq: seqLabel })}
				onChange={(event) => {
					onDraftChange(event.target.value);
					// Any edit retires the previous verdict — a stale "Sent" sitting over
					// new text reads as a receipt for the wrong message.
					if (state.phase === "sent" || state.phase === "error") onStateChange({ phase: "idle" });
				}}
				onKeyDown={(event) => {
					// House convention (TerminalComposer, ScheduleMessageModal): Enter is a
					// newline, the modifier sends.
					if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
						event.preventDefault();
						send();
					}
				}}
			/>
			<div className="traffic-compose-foot">
				<p
					className={`traffic-compose-status is-${status.tone}`}
					data-testid="traffic-composer-status"
					role="status"
				>
					<span className={state.phase === "error" ? "streamer-private" : undefined}>{status.text}</span>
				</p>
				{remaining <= COUNTER_VISIBLE_FROM && <span className="traffic-compose-count">{remaining}</span>}
				{/* Not `traffic-primary`: the accent fill stays unique to "Open task",
				    the one action on this screen that changes where you are. */}
				<button
					className="traffic-compose-send"
					disabled={!canSend}
					onClick={send}
					data-testid="traffic-composer-send"
				>
					{busy ? t("traffic.compose.sending") : t("traffic.compose.send")}
				</button>
			</div>
		</div>
	);
}
