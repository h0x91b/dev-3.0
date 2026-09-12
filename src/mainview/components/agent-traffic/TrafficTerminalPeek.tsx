/**
 * Terminal snapshot for the selected task, inside the Agent traffic inspector.
 *
 * It is TEXT, and it says so: the only screen-read primitives this app has today
 * are `capture-pane` and its native counterpart, so there is nothing to build a
 * picture from and nothing here may be called a screenshot. Escapes are stripped
 * by the shared peek contract, so colours do not survive either. A readable tail
 * therefore exists on tmux; a native backend publishes no screen and says so.
 *
 * Nothing is read until the user asks. There is no polling and no prefetch
 * across graph nodes — one node, one explicit read, plus a Refresh. The only
 * thing that ticks is the age label, which re-renders text already fetched.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../rpc";
import { useT } from "../../i18n";
import {
	formatAge,
	isCaptureUnsupported,
	type PeekPane,
	type TaskPeekSnapshot,
} from "../../../shared/task-peek";

/** A narrow inspector needs a screen's worth of tail, not peek's agent-sized budget. */
const PEEK_LINES = 60;
/** How often the "Read Ns ago" label refreshes. Text only — never a refetch. */
const AGE_TICK_MS = 5000;

interface Props {
	taskId: string;
	projectId: string;
}

export default function TrafficTerminalPeek({ taskId, projectId }: Props) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [snapshot, setSnapshot] = useState<TaskPeekSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pane, setPane] = useState<string | undefined>(undefined);
	const [, setTick] = useState(0);
	// Only the newest request may write state: a Refresh or a pane switch can
	// land out of order, and an older answer must never overwrite a newer one.
	const requestSeq = useRef(0);
	const screenRef = useRef<HTMLPreElement>(null);
	const sectionRef = useRef<HTMLElement>(null);

	const read = useCallback(
		async (paneSelector?: string) => {
			const seq = ++requestSeq.current;
			setLoading(true);
			setError(null);
			try {
				const result = await api.request.peekTaskTerminal({
					taskId,
					projectId,
					pane: paneSelector,
					lines: PEEK_LINES,
				});
				if (seq !== requestSeq.current) return;
				// The answer must be about the task we asked about; anything else is
				// another task's terminal and is dropped rather than rendered.
				if (result.taskId !== taskId) return;
				setSnapshot(result);
			} catch (err) {
				if (seq !== requestSeq.current) return;
				setError(String(err));
			} finally {
				if (seq === requestSeq.current) setLoading(false);
			}
		},
		[taskId, projectId],
	);

	useEffect(() => {
		if (!open) return;
		const timer = setInterval(() => setTick((n) => n + 1), AGE_TICK_MS);
		return () => clearInterval(timer);
	}, [open]);

	// A terminal is read bottom-up: land on the newest line, not the oldest. The
	// detail box scrolls too, and an expansion that lands below its fold reads as
	// an empty disclosure — so bring the snapshot into view with it.
	useEffect(() => {
		const el = screenRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		// The whole block, not the screen alone, so its own heading stays readable.
		sectionRef.current?.scrollIntoView({ block: "nearest" });
	}, [snapshot]);

	function toggle() {
		if (open) {
			setOpen(false);
			return;
		}
		setOpen(true);
		if (!snapshot) void read(pane);
	}

	function choosePane(target: PeekPane) {
		setPane(target.paneId);
		void read(target.paneId);
	}

	return (
		<section ref={sectionRef} className="traffic-peek">
			<div className="traffic-peek-head">
				<button
					className="traffic-peek-toggle"
					aria-expanded={open}
					onClick={toggle}
				>
					{t("traffic.terminal.title")}
					<span>{open ? t("traffic.terminal.hide") : t("traffic.terminal.show")}</span>
				</button>
				{open && (
					<button className="traffic-peek-refresh" disabled={loading} onClick={() => void read(pane)}>
						{t("traffic.terminal.refresh")}
					</button>
				)}
			</div>
			{open && (
				<div className="traffic-peek-body">
					{loading && !snapshot ? (
						<p className="traffic-peek-note">{t("traffic.terminal.loading")}</p>
					) : error ? (
						<p className="traffic-peek-note">{t("traffic.terminal.failed", { error })}</p>
					) : snapshot ? (
						<Snapshot snapshot={snapshot} activePane={pane} onPane={choosePane} screenRef={screenRef} />
					) : null}
				</div>
			)}
		</section>
	);
}

function Snapshot({
	snapshot,
	activePane,
	onPane,
	screenRef,
}: {
	snapshot: TaskPeekSnapshot;
	activePane: string | undefined;
	onPane: (pane: PeekPane) => void;
	screenRef: React.RefObject<HTMLPreElement | null>;
}) {
	const t = useT();
	const panes = snapshot.panes;
	const shown = snapshot.tail
		? panes.find((p) => p.paneId === snapshot.tail?.paneId)
		: panes.find((p) => p.paneId === activePane);

	return (
		<>
			{panes.length > 1 && (
				<div className="traffic-peek-panes" role="group" aria-label={t("traffic.terminal.title")}>
					{panes.map((p) => (
						<button
							key={p.paneId}
							aria-pressed={p.paneId === (shown?.paneId ?? activePane)}
							onClick={() => onPane(p)}
						>
							{p.label || t("traffic.terminal.pane", { index: String(p.index) })}
						</button>
					))}
				</div>
			)}
			<p className="traffic-peek-meta">
				{shown
					? `${t("traffic.terminal.paneOf", { index: String(shown.index), total: String(panes.length) })} · `
					: ""}
				{t("traffic.terminal.observed", { age: formatAge(Date.now() - Date.parse(snapshot.observedAt)) })}
			</p>
			{/* Above the text, never below it: the reader must know what they are
			    looking at before they look, and the panel scrolls. It is a claim
			    about text, so it only appears when there is text. */}
			{snapshot.tail && (
				<p className="traffic-peek-note traffic-peek-disclaimer">{t("traffic.terminal.isText")}</p>
			)}
			<Unavailable snapshot={snapshot} />
			{snapshot.tail &&
				(snapshot.tail.text.trim() ? (
					<pre ref={screenRef} className="traffic-peek-screen streamer-private">
						{snapshot.tail.text}
					</pre>
				) : (
					<p className="traffic-peek-note">{t("traffic.terminal.nothing")}</p>
				))}
		</>
	);
}

/**
 * The misses read differently on purpose. "We could not read it" must never look
 * like "it is quiet" — that confusion is what the peek contract exists to
 * prevent. A backend that publishes no screen at all gets its own plain sentence
 * rather than the generic failure, because "we could not read it" invites the
 * user to retry something that will never work here; the backend's own token
 * stays underneath as diagnostic text.
 */
function Unavailable({ snapshot }: { snapshot: TaskPeekSnapshot }) {
	const t = useT();
	const miss = snapshot.unavailable;
	if (!miss) return null;
	if (miss.kind === "no-session") {
		return <p className="traffic-peek-note">{t("traffic.terminal.noSession", { detail: miss.detail })}</p>;
	}
	const headline = isCaptureUnsupported(miss)
		? t("traffic.terminal.captureUnsupported")
		: miss.kind === "pane-not-found"
			? t("traffic.terminal.paneNotFound")
			: t("traffic.terminal.readFailed");
	return (
		<div className="traffic-peek-note">
			<p>{headline}</p>
			<code>{miss.detail}</code>
		</div>
	);
}
