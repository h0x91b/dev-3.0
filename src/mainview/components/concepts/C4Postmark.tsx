/**
 * Concept 4 — Postmark. The message lives on the Kanban card of the task that
 * received it, as persistent unread state rather than a transient event.
 *
 * A stamp in the card's top-right corner names the sender and the direction, and
 * pulses once on arrival. It does not time out: it stays until the card is
 * opened, which is why coming back an hour later still shows what happened.
 * Repeats thicken the stamp (`×2`) instead of stacking.
 */

import { COORDINATOR, MESSAGES, TONE_COLOR, WORKERS, shortTitle, type ConceptTask } from "./fixtures";

function inboundFor(seq: number) {
	const rows = MESSAGES.filter((m) => m.to.seq === seq);
	return rows.length ? { from: rows[0].from, count: rows.length, body: rows[0].body } : null;
}

function Card({ task, first }: { task: ConceptTask; first: boolean }) {
	const mail = inboundFor(task.seq);
	return (
		<div
			className="relative rounded-lg border p-3 pr-3"
			style={{
				background: "rgb(var(--glass-card-rgb) / var(--glass-card-alpha))",
				borderColor: "rgb(var(--glass-border-rgb) / var(--glass-border-card-alpha))",
				borderLeft: `2px solid ${TONE_COLOR[task.tone]}`,
			}}
		>
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<div className="text-sm text-fg leading-snug pr-16">{shortTitle(task, 34)}</div>
					<div className="text-micro font-mono text-fg-muted mt-1">#{task.seq}</div>
				</div>
			</div>

			{mail && (
				<div
					className="absolute top-2.5 right-2.5 flex items-center gap-1 h-5 pl-1 pr-1.5 rounded-md"
					style={{
						background: "rgb(var(--agent) / 0.14)",
						border: "1px solid rgb(var(--agent) / 0.45)",
						...(first ? { animation: "concept-stamp 2.6s ease-out infinite" } : {}),
					}}
					title={mail.body}
				>
					<span className="text-micro leading-none" style={{ color: "rgb(var(--agent))" }}>
						⇠
					</span>
					<span className="text-micro font-mono tabular-nums" style={{ color: "rgb(var(--agent))" }}>
						{mail.from.seq}
					</span>
					{mail.count > 1 && (
						<span className="text-micro font-mono tabular-nums" style={{ color: "rgb(var(--agent) / 0.75)" }}>
							×{mail.count}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

export function C4Postmark() {
	const cards = [COORDINATOR, ...WORKERS];
	return (
		<div className="w-[19rem]">
			<div
				className="rounded-xl border p-2.5 space-y-2"
				style={{
					background: "rgb(var(--glass-column-rgb) / var(--glass-column-alpha))",
					borderColor: "rgb(var(--glass-border-rgb) / var(--glass-border-column-alpha))",
					boxShadow: "var(--shadow-column)",
				}}
			>
				<div className="flex items-center gap-2 px-1 pb-1">
					<span className="w-2 h-2 rounded-full" style={{ background: "rgb(var(--accent))" }} />
					<span className="text-micro font-mono text-fg-2 uppercase tracking-wider">Agent is working</span>
					<span className="text-micro font-mono text-fg-muted ml-auto">{cards.length}</span>
				</div>
				{cards.map((task, i) => (
					<Card key={task.seq} task={task} first={i === 1} />
				))}
			</div>
		</div>
	);
}
