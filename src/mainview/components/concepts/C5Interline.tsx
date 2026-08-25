/**
 * Concept 5 — Interline. The announcement is rendered where the text actually
 * landed: inside the receiving task's terminal chrome, between the tab strip and
 * the pane.
 *
 * This one deliberately LEADS WITH THE TEXT, against the analysis that says both
 * identities matter and the body does not. The claim is made on purpose: if you
 * are already looking at the pane that received it, identity is context you
 * already have, and the body is the only new information. Nothing global appears
 * anywhere — the price is that the board learns nothing.
 */

import { MESSAGES, TONE_COLOR } from "./fixtures";

export function C5Interline() {
	const m = MESSAGES[0];

	return (
		<div className="w-[38rem] bg-base border border-edge rounded-xl overflow-hidden shadow-2xl">
			{/* Terminal tab strip. */}
			<div className="flex items-center gap-1 h-9 px-2 border-b border-edge/50 bg-raised">
				<div className="h-6 px-2.5 flex items-center rounded-md bg-elevated border border-edge/60 text-micro font-mono text-fg">
					agent
				</div>
				<div className="h-6 px-2.5 flex items-center rounded-md text-micro font-mono text-fg-muted">shell</div>
				<div className="h-6 px-2.5 flex items-center rounded-md text-micro font-mono text-fg-muted">dev</div>
			</div>

			{/* The interline. Single row, 26px, slides down and stays until the next
			    keystroke in this pane, then slides away. */}
			<div
				className="flex items-center gap-2 h-7 px-3 overflow-hidden"
				style={{
					background: "rgb(var(--agent) / 0.10)",
					borderBottom: "1px solid rgb(var(--agent) / 0.28)",
					animation: "concept-interline 4s ease-in-out infinite",
				}}
			>
				<span
					className="w-1 h-3.5 rounded-full flex-shrink-0"
					style={{ background: TONE_COLOR[m.from.tone] }}
				/>
				<span className="text-micro leading-none flex-shrink-0" style={{ color: "rgb(var(--agent))" }}>
					⇠
				</span>
				<span className="text-sm text-fg truncate flex-1 min-w-0 leading-none">{m.body}</span>
				<span className="text-micro font-mono text-fg-muted flex-shrink-0 tabular-nums">#{m.from.seq}</span>
			</div>

			{/* Terminal body. */}
			<div className="p-3 font-mono text-micro leading-relaxed" style={{ color: "rgb(var(--text-tertiary))" }}>
				<div>
					<span style={{ color: "rgb(var(--success))" }}>✓</span> bun run lint — clean
				</div>
				<div>
					<span style={{ color: "rgb(var(--success))" }}>✓</span> 383 files, 2 811 tests passed
				</div>
				<div className="text-fg-muted">&gt; waiting for the aggregate check…</div>
				<div className="pt-1">
					<span style={{ color: "rgb(var(--accent))" }}>❯</span>{" "}
					<span className="inline-block w-1.5 h-3 align-middle" style={{ background: "rgb(var(--text-primary))" }} />
				</div>
			</div>
		</div>
	);
}
