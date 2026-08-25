/**
 * Concept 6 — Escalation. Silence by default; one bar when it matters.
 *
 * Ordinary traffic raises NOTHING — it goes straight to the ledger and is only
 * ever seen on purpose. A single bar appears only when the message is escalated,
 * and it names the collision rather than quoting the sender.
 *
 * HONEST GAP: nothing produces the escalation signal today. `dev3 message` has no
 * importance field, and the collision line below ("both tasks are editing
 * toast.tsx") would need per-task file-touch state that dev3 does not track. The
 * concept is shown anyway because the missing axis is the actual problem: five
 * "test N" messages and one blocker currently cost the same attention.
 */

import { MESSAGES } from "./fixtures";

export function C6Escalation() {
	const m = MESSAGES.find((x) => x.urgent) ?? MESSAGES[0];

	return (
		<div className="w-[42rem] space-y-4">
			{/* The escalated bar. One at a time, ever. */}
			<div
				className="flex items-center gap-3 h-11 px-3 rounded-lg border"
				style={{
					background: "rgb(var(--warning-fill) / 0.28)",
					borderColor: "rgb(var(--warning) / 0.55)",
					boxShadow: "0 0 0 1px rgb(var(--warning) / 0.12), 0 8px 24px -12px rgb(var(--warning) / 0.4)",
				}}
			>
				<span
					className="w-2 h-2 rounded-full flex-shrink-0"
					style={{ background: "rgb(var(--warning))", animation: "concept-pulse 1.8s ease-in-out infinite" }}
				/>
				<div className="min-w-0 flex-1">
					<div className="text-sm leading-tight" style={{ color: "rgb(var(--text-primary))" }}>
						<span className="font-mono tabular-nums">#{m.to.seq}</span> and{" "}
						<span className="font-mono tabular-nums">#{m.from.seq}</span> are both editing{" "}
						<span className="font-mono">src/mainview/toast.tsx</span>
					</div>
					<div className="text-micro font-mono truncate" style={{ color: "rgb(var(--text-tertiary))" }}>
						#{m.from.seq} → #{m.to.seq} · “{m.body}”
					</div>
				</div>
				<button
					type="button"
					className="h-7 px-2.5 rounded-md text-micro font-mono flex-shrink-0"
					style={{ background: "rgb(var(--warning) / 0.16)", color: "rgb(var(--warning-strong))" }}
				>
					Open #{m.to.seq}
				</button>
				<button type="button" className="h-7 px-2 rounded-md text-micro font-mono text-fg-muted flex-shrink-0">
					Dismiss
				</button>
			</div>

			{/* What the same board looks like for everything that is NOT escalated. */}
			<div className="rounded-lg border border-edge/50 border-dashed p-3">
				<div className="text-micro font-mono text-fg-muted mb-2 uppercase tracking-wider">
					The other 7 messages, same minute
				</div>
				<div className="flex items-center gap-2">
					<span className="text-sm text-fg-muted italic">nothing on screen</span>
					<span className="text-micro font-mono text-fg-muted ml-auto">→ ledger, 7</span>
				</div>
			</div>
		</div>
	);
}
