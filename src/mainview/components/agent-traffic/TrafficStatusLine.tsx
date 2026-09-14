import { useEffect, useRef, useState } from "react";
import TrafficIcon from "./TrafficIcon";

/** How long the outgoing word stays on screen. Long enough to be caught out of
 *  the corner of the eye: at 220ms the swap was over before it registered. */
export const STATUS_SWAP_MS = 420;

export interface StatusLineProps {
	/** The status word exactly as the card prints it. */
	label: string;
	/** Verdict statuses print a stamp instead of a plain word. */
	finished: "completed" | "cancelled" | null;
	reduced: boolean;
}

/**
 * The card's status line, cross-fading whenever the word it prints changes.
 *
 * One ghost slot, never a queue: a second change mid-fade drops the stale word
 * instead of stacking another animation on the card. The outgoing copy is
 * absolutely positioned over the line, so the swap costs no layout movement and
 * never shifts the cards around it.
 */
export default function TrafficStatusLine({ label, finished, reduced }: StatusLineProps) {
	const swap = useStatusSwap({ label, finished }, !reduced);
	return (
		<span className="traffic-node-status-line">
			{swap.ghost && (
				<span
					key={`ghost-${swap.token}`}
					className="traffic-node-status-ghost"
					data-testid="traffic-node-status-ghost"
					aria-hidden="true"
				>
					<StatusBody {...swap.ghost} />
				</span>
			)}
			<span key={`live-${swap.token}`} className="traffic-node-status-live">
				<StatusBody label={label} finished={finished} />
			</span>
		</span>
	);
}

function StatusBody({ label, finished }: { label: string; finished: "completed" | "cancelled" | null }) {
	if (!finished) return <span className="traffic-node-state">{label}</span>;
	return (
		<span className={`traffic-node-stamp is-${finished}`}>
			<TrafficIcon name={finished === "completed" ? "check" : "cross"} />
			{label}
		</span>
	);
}

interface Shown {
	label: string;
	finished: "completed" | "cancelled" | null;
}

/**
 * Keeps the value that was just replaced for {@link STATUS_SWAP_MS}, and a token
 * that restarts the animation on every swap. With motion off it keeps no ghost at
 * all — the new status is simply there, which is the accurate reading of it.
 */
function useStatusSwap(shown: Shown, enabled: boolean): { ghost: Shown | null; token: number } {
	const [swap, setSwap] = useState<{ ghost: Shown | null; token: number }>({ ghost: null, token: 0 });
	const previous = useRef(shown);
	useEffect(() => {
		const gone = previous.current;
		if (gone.label === shown.label && gone.finished === shown.finished) return;
		previous.current = shown;
		setSwap((current) =>
			enabled
				? { ghost: gone, token: current.token + 1 }
				: { ghost: null, token: current.token },
		);
	}, [shown.label, shown.finished, enabled]);
	useEffect(() => {
		if (!swap.ghost) return;
		const timer = setTimeout(
			() => setSwap((current) => (current.token === swap.token ? { ghost: null, token: current.token } : current)),
			STATUS_SWAP_MS,
		);
		return () => clearTimeout(timer);
	}, [swap.ghost, swap.token]);
	return swap;
}
