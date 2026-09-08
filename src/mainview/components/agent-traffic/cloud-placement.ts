/**
 * Where each cloud goes on a canvas that is already full of cards.
 *
 * Why this is a function over ALL the clouds rather than a rule inside one:
 * two clouds cannot avoid each other from inside their own components. Each is
 * its own React element and knows nothing about where the others landed, so a
 * per-cloud rule can dodge the cards and still stack two clouds on the same
 * pixels — measured, on a stand that drew several at once, where they clipped
 * each other's text. Placing them together is the only shape that can see that.
 *
 * What it will NOT do: move a card, hide a cloud, or shrink text. Those were
 * ruled out, and each one trades a readable notification for a tidy picture.
 * When nothing fits, it takes the least-bad position and SAYS so, so the caller
 * and the reader are never told a lie about the result.
 */

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface CloudToPlace {
	key: string;
	/** Top-centre of the card that sent it, in canvas coordinates. */
	anchor: { x: number; y: number; height?: number };
	/** The cloud's own measured size. */
	size: { width: number; height: number };
}

export interface CloudPlacement {
	left: number;
	top: number;
	/** Which side of the card it ended up on, so the trail can point the right way. */
	side: "above" | "below";
	/**
	 * Area of this cloud still covered by a card or another cloud, in px².
	 *
	 * Zero on a clean placement. Non-zero is the honest answer for a canvas with
	 * no room in it, and it is reported rather than hidden so an acceptance run
	 * measures the truth instead of the intent.
	 */
	overlap: number;
}

/** Gap between the cloud and the card it hangs on, above and below. */
const ABOVE_GAP = 6;
const BELOW_GAP = 14;
/** Keep the cloud off the canvas edge by this much. */
const EDGE = 4;
/**
 * How far sideways a cloud may slide from its card, as a fraction of its width.
 *
 * The trail has to keep pointing at the sender, and it starts near the cloud's
 * centre — so past roughly a third of the width the thought stops visibly
 * belonging to its card, which is worse than an overlap.
 */
const MAX_SLIDE = 0.34;
/**
 * How many storeys away from its card a cloud may be pushed.
 *
 * A burst puts several clouds in one row of cards, and the column pitch there is
 * far narrower than a cloud — measured: 88px pitch against a 255px cloud, so two
 * neighbours cannot share a storey at all, however far they slide. Stacking is
 * the only way they coexist. Bounded at three because a cloud four storeys up no
 * longer reads as belonging to its card.
 */
const MAX_STOREYS = 3;
/** Vertical air between two stacked clouds. */
const STACK_GAP = 8;

function overlapArea(a: Rect, b: Rect): number {
	const x = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
	const y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	return x > 0 && y > 0 ? x * y : 0;
}

function clampIntoCanvas(rect: Rect, canvas: { width: number; height: number }): Rect {
	// Clamped in both axes, always. A cloud pushed off the edge crosses nothing
	// and therefore measures as a perfect placement while being invisible — that
	// exact false win is why this is not optional.
	return {
		...rect,
		left: Math.max(EDGE, Math.min(canvas.width - rect.width - EDGE, rect.left)),
		top: Math.max(EDGE, Math.min(canvas.height - rect.height - EDGE, rect.top)),
	};
}

/**
 * Candidate positions for one cloud, best first.
 *
 * Order is the whole policy: the side comes before the sideways slide, because a
 * cloud on the wrong side still reads as its card's thought while a cloud slid
 * halfway across the canvas does not. Above beats below for the same reason a
 * thought bubble sits over a head.
 */
interface Candidate {
	rect: Rect;
	/** The side this candidate MEANT, which the clamp must not silently change. */
	side: "above" | "below";
}

function candidates(cloud: CloudToPlace, canvas: { width: number; height: number }): Candidate[] {
	const { anchor, size } = cloud;
	const centred = anchor.x - size.width / 2;
	const slide = size.width * MAX_SLIDE;
	const lefts = [centred, centred - slide * 0.5, centred + slide * 0.5, centred - slide, centred + slide];
	const out: Candidate[] = [];
	// Storey outermost, then side, then the sideways slide. That order is the
	// policy: stay as close to the card as possible, prefer above, and only then
	// wander sideways — a cloud slid halfway across the canvas has stopped saying
	// which card thought it.
	for (let storey = 0; storey < MAX_STOREYS; storey += 1) {
		const lift = storey * (size.height + STACK_GAP);
		const tops = [
			{ side: "above" as const, top: anchor.y - size.height - ABOVE_GAP - lift },
			{ side: "below" as const, top: anchor.y + (anchor.height ?? 0) + BELOW_GAP + lift },
		];
		for (const { side, top } of tops)
			for (const left of lefts)
				out.push({ side, rect: clampIntoCanvas({ left, top, width: size.width, height: size.height }, canvas) });
	}
	return out;
}

/**
 * Place every cloud, newest first.
 *
 * Newest first because the newest notification is the one the reader is looking
 * for: when the canvas runs out of room, the cloud that has to compromise should
 * be the older one. `clouds` is expected oldest-first, as a timeline is read.
 */
export function placeClouds(input: {
	canvas: { width: number; height: number };
	/** Cards, and anything else a cloud must not cover, in canvas coordinates. */
	obstacles?: readonly Rect[];
	clouds: readonly CloudToPlace[];
}): Map<string, CloudPlacement> {
	const obstacles = input.obstacles ?? [];
	const placed: Rect[] = [];
	const out = new Map<string, CloudPlacement>();
	// A cloud never counts its OWN card as an obstacle: it is supposed to touch it,
	// and the trail deliberately reaches down to it.
	const ownCard = (cloud: CloudToPlace): Rect => ({
		left: cloud.anchor.x - 1,
		top: cloud.anchor.y,
		width: 2,
		height: Math.max(1, cloud.anchor.height ?? 0),
	});

	for (const cloud of [...input.clouds].reverse()) {
		const mine = ownCard(cloud);
		const blockers = [...obstacles.filter(rect => overlapArea(rect, mine) === 0), ...placed];
		let best: { candidate: Candidate; overlap: number } | null = null;
		for (const candidate of candidates(cloud, input.canvas)) {
			const overlap = blockers.reduce((sum, blocker) => sum + overlapArea(candidate.rect, blocker), 0);
			if (overlap === 0) {
				best = { candidate, overlap };
				break;
			}
			if (!best || overlap < best.overlap) best = { candidate, overlap };
		}
		// `candidates` is never empty, so `best` is always set; the assertion is for
		// the type, not for a case that can happen.
		const chosen = best!;
		placed.push(chosen.candidate.rect);
		// The side comes from the candidate, never from the final coordinates: a
		// clamp can push a "below" box back up past its own anchor, and deriving the
		// side from geometry then points the thought trail at nothing.
		out.set(cloud.key, {
			left: chosen.candidate.rect.left,
			top: chosen.candidate.rect.top,
			side: chosen.candidate.side,
			overlap: Math.round(chosen.overlap),
		});
	}
	return out;
}
