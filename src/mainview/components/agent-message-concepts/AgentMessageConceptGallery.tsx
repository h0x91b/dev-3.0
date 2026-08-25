/**
 * Concept harness — mounted only when the app URL carries `?msgconcepts=1`, so
 * the six designs can be screenshotted inside the real app chrome without
 * touching the live notification path. Throwaway: hardcoded English, no i18n,
 * no tests, no RPC. Keys 1…6 switch concepts, 0 shows none.
 */
import { useEffect, useState } from "react";
import {
	C1Wire,
	C2Switchboard,
	C3BoardWiring,
	C4SidebarLane,
	C5TerminalSeam,
	C6TrafficLog,
	ConceptCaption,
} from "./concepts";

const CONCEPTS = [
	{ n: 1, title: "Wire", note: "one 30px line, identities lead, burst folds to ×N" },
	{ n: 2, title: "Switchboard", note: "permanent header readout, popover on demand, zero interruption" },
	{ n: 3, title: "Board wiring", note: "no notification — the board draws who talks to whom" },
	{ n: 4, title: "Queue lane", note: "traffic folded into the sidebar, ordered by who is owed an answer" },
	{ n: 5, title: "Terminal seam", note: "a hairline where the text actually landed, plus a gutter ruler" },
	{ n: 6, title: "Traffic log", note: "a permanent destination — what happened while I was away" },
];

export function isConceptGalleryEnabled(): boolean {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("msgconcepts") === "1";
}

export default function AgentMessageConceptGallery() {
	const [active, setActive] = useState(1);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const n = Number(e.key);
			if (Number.isInteger(n) && n >= 0 && n <= 6) setActive(n);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const meta = CONCEPTS.find((c) => c.n === active);

	return (
		<>
			<div className="fixed bottom-3 left-3 z-[80] flex items-center gap-1 rounded-full border border-edge bg-overlay/95 px-2 py-1.5 shadow-popover">
				<span className="font-mono text-dense text-fg-muted pr-1">concepts</span>
				{CONCEPTS.map((c) => (
					<button
						key={c.n}
						type="button"
						onClick={() => setActive(c.n)}
						className={`h-6 w-6 rounded-full font-mono text-micro ${
							active === c.n ? "bg-agent/20 text-agent" : "text-fg-3 hover:bg-raised-hover"
						}`}
					>
						{c.n}
					</button>
				))}
			</div>

			{active === 1 && <C1Wire />}
			{active === 2 && <C2Switchboard open />}
			{active === 3 && <C3BoardWiring />}
			{active === 4 && <C4SidebarLane />}
			{active === 5 && <C5TerminalSeam />}
			{active === 6 && <C6TrafficLog />}

			{meta && <ConceptCaption n={meta.n} title={meta.title} note={meta.note} />}
		</>
	);
}
