/**
 * Throwaway concept gallery for agent-to-agent message display.
 *
 * Mounted only when the URL carries `?concepts=agent-msg`, so it costs the real
 * app nothing. Six divergent concepts plus the shipping toast for comparison;
 * `&c=<n>` picks one, digits 0–6 switch. Copy is hardcoded English on purpose —
 * this is scaffolding for screenshots, not a feature, so nothing here is
 * routed through `t()`.
 */

import { useEffect, useState } from "react";
import { toast } from "../../toast";
import { C1Wire } from "./C1Wire";
import { C2Switchboard } from "./C2Switchboard";
import { C3Ledger } from "./C3Ledger";
import { C4Postmark } from "./C4Postmark";
import { C5Interline } from "./C5Interline";
import { C6Escalation } from "./C6Escalation";
import { COORDINATOR, MESSAGES, WORKERS } from "./fixtures";

export function agentMessageConceptsRequested(): boolean {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("concepts") === "agent-msg";
}

interface Concept {
	n: number;
	name: string;
	where: string;
	render: () => React.ReactNode;
}

const CONCEPTS: Concept[] = [
	{ n: 1, name: "Wire", where: "sidebar gutter · ambient · no popup", render: () => <C1Wire /> },
	{ n: 2, name: "Switchboard", where: "one permanent 32px line · pairs, not messages", render: () => <C2Switchboard /> },
	{ n: 3, name: "Ledger", where: "permanent surface · grouped by pair · no toast at all", render: () => <C3Ledger /> },
	{ n: 4, name: "Postmark", where: "on the receiving Kanban card · persistent unread", render: () => <C4Postmark /> },
	{ n: 5, name: "Interline", where: "inside the receiving terminal · leads with the text", render: () => <C5Interline /> },
	{ n: 6, name: "Escalation", where: "silence by default · one bar when it matters", render: () => <C6Escalation /> },
];

export function AgentMessageConcepts() {
	const initial = Number(new URLSearchParams(window.location.search).get("c") ?? "1");
	const [active, setActive] = useState(Number.isFinite(initial) ? initial : 1);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const n = Number(e.key);
			if (Number.isInteger(n) && n >= 0 && n <= 6) setActive(n);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	/** Raises the real shipping toast, so the comparison is the component itself. */
	function raiseCurrent(): void {
		for (const m of MESSAGES.slice(0, 3)) {
			toast.agent(`“${m.body}”`, { context: `#${m.from.seq} ${m.from.title} → #${m.to.seq} ${m.to.title}` });
		}
	}

	const concept = CONCEPTS.find((c) => c.n === active);

	return (
		// Below ToastHost's z-[55] on purpose: option 0 raises the real toast and it
		// must render ON TOP of the gallery for the comparison to be honest.
		<div className="fixed inset-0 z-[50] flex bg-base">
			<nav className="w-56 flex-shrink-0 border-r border-edge/60 bg-raised p-3 space-y-1">
				<div className="text-micro font-mono text-fg-muted uppercase tracking-wider px-2 pb-2">
					Agent message · 6 concepts
				</div>
				<button
					type="button"
					onClick={() => {
						setActive(0);
						raiseCurrent();
					}}
					className={`w-full text-left px-2 py-1.5 rounded-md text-sm ${active === 0 ? "bg-elevated text-fg" : "text-fg-muted hover:bg-raised-hover"}`}
				>
					<span className="font-mono text-micro mr-2">0</span>Current (toast)
				</button>
				{CONCEPTS.map((c) => (
					<button
						key={c.n}
						type="button"
						onClick={() => setActive(c.n)}
						className={`w-full text-left px-2 py-1.5 rounded-md text-sm ${active === c.n ? "bg-elevated text-fg" : "text-fg-muted hover:bg-raised-hover"}`}
					>
						<span className="font-mono text-micro mr-2">{c.n}</span>
						{c.name}
					</button>
				))}
				<div className="pt-3 px-2 text-micro font-mono text-fg-muted leading-relaxed">
					{COORDINATOR.seq} coordinates {WORKERS.length} workers · {MESSAGES.length} messages in the last hour
				</div>
			</nav>

			<div className="flex-1 min-w-0 overflow-auto p-10 flex flex-col items-center justify-center gap-6">
				{concept ? (
					<>
						<div className="text-center">
							<div className="text-lg text-fg">
								<span className="font-mono text-fg-muted mr-2">{concept.n}</span>
								{concept.name}
							</div>
							<div className="text-micro font-mono text-fg-muted pt-1">{concept.where}</div>
						</div>
						{concept.render()}
					</>
				) : (
					<div className="text-center">
						<div className="text-lg text-fg">Current — the shipping `agent` toast</div>
						<div className="text-micro font-mono text-fg-muted pt-1">
							three messages, top right · the thing being replaced
						</div>
					</div>
				)}
			</div>

			<style>{`
				@keyframes concept-spark { 0% { top: -10px; opacity: 0 } 15% { opacity: 1 } 85% { opacity: 1 } 100% { top: 100%; opacity: 0 } }
				@keyframes concept-pulse { 0%, 100% { opacity: 0.45; transform: scale(1) } 50% { opacity: 1; transform: scale(1.25) } }
				@keyframes concept-nudge { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(2px) } }
				@keyframes concept-stamp { 0% { transform: scale(1) } 6% { transform: scale(1.12) } 14% { transform: scale(1) } }
				@keyframes concept-interline { 0%, 8% { height: 0; opacity: 0 } 16%, 100% { height: 1.75rem; opacity: 1 } }
			`}</style>
		</div>
	);
}
