/**
 * Where the transient person and their speech bubble stand.
 *
 * The natural place is directly above the card they wrote to, and that is the
 * first thing tried. It is not always free: a coordinator sits above the grid,
 * and replay reorders the cards under the cursor, so the same recipient is above
 * open space in one step and under a card in the next. When the natural place is
 * taken the pair moves together to the nearest free space and a short tether
 * says which card they are talking to.
 */

export interface SpeakerRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Bubble, air, head and label — what the pair actually occupies on the stage. */
export const SPEAKER_WIDTH = 292;
export const SPEAKER_HEIGHT = 212;
/** Air between the pair and whatever it stands next to. */
export const SPEAKER_GAP = 18;
/** Cards are given this much elbow room so the pair never grazes one. */
const CLEARANCE = 12;
/** Box bottom → the middle of the head: where a tether leaves the person. */
const LABEL_TO_HEAD = 66;

export interface SpeakerPlacement extends SpeakerRect {
	/** False when the pair stands anywhere but its natural spot above the card. */
	natural: boolean;
	/** Drawn only when displaced: pair edge → recipient edge, shortest run. */
	tether?: { from: { x: number; y: number }; to: { x: number; y: number } };
}

const overlap = (a: SpeakerRect, b: SpeakerRect) =>
	Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
	Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The point of `rect` closest to `point` — where a tether meets a box. */
function nearest(rect: SpeakerRect, point: { x: number; y: number }) {
	return {
		x: Math.min(Math.max(point.x, rect.x), rect.x + rect.width),
		y: Math.min(Math.max(point.y, rect.y), rect.y + rect.height),
	};
}

/**
 * @param recipient the card the message went to
 * @param cards every card on the stage, recipient included
 */
export function placeSpeaker(
	recipient: SpeakerRect,
	cards: SpeakerRect[],
	size: { width: number; height: number } = { width: SPEAKER_WIDTH, height: SPEAKER_HEIGHT },
): SpeakerPlacement {
	const { width, height } = size;
	const midX = recipient.x + recipient.width / 2 - width / 2;
	const above = recipient.y - SPEAKER_GAP - height;
	const below = recipient.y + recipient.height + SPEAKER_GAP;
	const left = recipient.x - SPEAKER_GAP - width;
	const right = recipient.x + recipient.width + SPEAKER_GAP;
	// Ordered by how little the reader has to move their eyes from the card.
	const candidates: SpeakerRect[] = [
		{ x: midX, y: above, width, height },
		{ x: left, y: recipient.y + recipient.height - height, width, height },
		{ x: right, y: recipient.y + recipient.height - height, width, height },
		{ x: left, y: above, width, height },
		{ x: right, y: above, width, height },
		{ x: midX, y: below, width, height },
	];
	const blockers = cards.map((card) => ({
		x: card.x - CLEARANCE,
		y: card.y - CLEARANCE,
		width: card.width + CLEARANCE * 2,
		height: card.height + CLEARANCE * 2,
	}));
	let best = candidates[0];
	let bestCost = Infinity;
	for (const [index, candidate] of candidates.entries()) {
		const cost = blockers.reduce((sum, card) => sum + overlap(candidate, card), 0);
		if (cost === 0) return index === 0 ? { ...candidate, natural: true } : tethered(candidate, recipient);
		if (cost < bestCost) {
			bestCost = cost;
			best = candidate;
		}
	}
	// Every spot is taken — the least covered one still reads better than a pair
	// sitting squarely on a card, and the tether keeps the recipient unambiguous.
	return best === candidates[0] ? { ...best, natural: true } : tethered(best, recipient);
}

function tethered(pair: SpeakerRect, recipient: SpeakerRect): SpeakerPlacement {
	// From the person, not from the corner of their reserved box: a short line
	// leaving thin air reads as a stray mark, one leaving their feet reads as
	// theirs. The box is wider than they are whenever the bubble is narrow.
	const feet = { x: pair.x + pair.width / 2, y: pair.y + pair.height - LABEL_TO_HEAD };
	return {
		...pair,
		natural: false,
		tether: { from: feet, to: nearest(recipient, feet) },
	};
}
