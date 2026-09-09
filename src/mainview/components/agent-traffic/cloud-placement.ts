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
 * The trail has to keep pointing at the sender, so this used to be a third of the
 * width. It was widened deliberately once the compact cloud started naming its
 * sender in words (#N): the connection no longer rests on the puffs alone, so a
 * further slide costs less than it did — and it buys clean placements that a
 * narrower sweep could not reach. Still bounded: a cloud on the far side of the
 * canvas belongs to nothing.
 */
const MAX_SLIDE = 0.5;
/**
 * How many sideways offsets to try between centred and {@link MAX_SLIDE}.
 *
 * Coarse steps miss pockets that exist: five offsets left a card's title fully
 * covered where a finer sweep finds a clean box. The cost is a few dozen
 * rectangle intersections for one cloud, which is nothing next to a hidden title.
 */
const SLIDE_STEPS = 8;
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
/**
 * How far the cloud's near edge may sit from its card, as a fraction of the
 * cloud's own height.
 *
 * Without this the storeys and the nudge will happily find a clean box 209px
 * above a card at the other end of the canvas and score it zero — measured, on
 * a real fixture. That is the same failure as scoring a cloud pushed off-screen
 * as perfect: the number is clean and the thing the cloud is for is gone. A
 * cloud that no longer reads as this card's thought is not a placement.
 */
const MAX_DETACH = 1.3;

function overlapArea(a: Rect, b: Rect): number {
	const x = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
	const y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	return x > 0 && y > 0 ? x * y : 0;
}

/** Vertical distance from the card to the cloud's nearest edge, 0 when touching. */
function detachment(rect: Rect, cloud: CloudToPlace): number {
	const cardTop = cloud.anchor.y;
	const cardBottom = cloud.anchor.y + (cloud.anchor.height ?? 0);
	if (rect.top + rect.height <= cardTop) return cardTop - (rect.top + rect.height);
	if (rect.top >= cardBottom) return rect.top - cardBottom;
	return 0;
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
	// Centred first, then alternating outwards in even steps, so the nearest clean
	// box always wins over a further one.
	const lefts = [centred];
	for (let step = 1; step <= SLIDE_STEPS; step += 1) {
		const offset = (slide * step) / SLIDE_STEPS;
		lefts.push(centred - offset, centred + offset);
	}
	const out: Candidate[] = [];
	// Storey outermost, then side, then the sideways slide. That order is the
	// policy: stay as close to the card as possible, prefer above, and only then
	// wander sideways — a cloud slid halfway across the canvas has stopped saying
	// which card thought it.
	const fallback: Candidate = {
		side: "above",
		rect: clampIntoCanvas({ left: centred, top: anchor.y - size.height - ABOVE_GAP, width: size.width, height: size.height }, canvas),
	};
	for (let storey = 0; storey < MAX_STOREYS; storey += 1) {
		const lift = storey * (size.height + STACK_GAP);
		const tops = [
			{ side: "above" as const, top: anchor.y - size.height - ABOVE_GAP - lift },
			{ side: "below" as const, top: anchor.y + (anchor.height ?? 0) + BELOW_GAP + lift },
		];
		for (const { side, top } of tops)
			for (const left of lefts) {
				const rect = clampIntoCanvas({ left, top, width: size.width, height: size.height }, canvas);
				// A clamp can turn a near candidate into a far one, so the distance is
				// checked AFTER it, on the box that would actually be drawn.
				if (detachment(rect, cloud) <= size.height * MAX_DETACH) out.push({ side, rect });
			}
	}
	// Never empty-handed: with an anchor far enough off-canvas that every candidate
	// is too detached, the caller still gets the centred box and an honest score.
	return out.length ? out : [fallback];
}

/**
 * Nudge a box straight out of whatever it still overlaps, and keep it if that
 * lands clean.
 *
 * The grid of candidates is a grid: a pocket can exist between its offsets, and
 * a coarse grid then reports "nowhere to go" for a canvas that has somewhere to
 * go. This is the cheap escape — for every blocker still touched, try the four
 * minimal translations that clear it, clamp, and re-score. Two passes, because
 * clearing one blocker can touch another.
 *
 * Bounded by `limit`: a nudge that carries the cloud further from its card than
 * the sideways sweep would have is not an improvement, it is a cloud belonging
 * to nothing.
 */
function pushOut(
	start: Rect,
	blockers: readonly Rect[],
	canvas: { width: number; height: number },
	limit: { left: number; right: number },
	cloud: CloudToPlace,
): Rect | null {
	let current = start;
	for (let pass = 0; pass < 2; pass += 1) {
		const hit = blockers.find(blocker => overlapArea(current, blocker) > 0);
		if (!hit) return current;
		const options: Rect[] = [
			{ ...current, left: hit.left - current.width - 1 },
			{ ...current, left: hit.left + hit.width + 1 },
			{ ...current, top: hit.top - current.height - 1 },
			{ ...current, top: hit.top + hit.height + 1 },
		]
			.map(rect => clampIntoCanvas(rect, canvas))
			.filter(rect => rect.left >= limit.left && rect.left <= limit.right)
			// Same bound as the grid: a nudge that detaches the cloud from its card is
			// not an escape, it is a different cloud.
			.filter(rect => detachment(rect, cloud) <= start.height * MAX_DETACH);
		let best: { rect: Rect; overlap: number } | null = null;
		for (const rect of options) {
			const overlap = blockers.reduce((sum, blocker) => sum + overlapArea(rect, blocker), 0);
			if (!best || overlap < best.overlap) best = { rect, overlap };
		}
		if (!best) return null;
		if (best.overlap === 0) return best.rect;
		current = best.rect;
	}
	return null;
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

	// The cloud's OWN card is an obstacle like any other. It was excluded once, on
	// the reasoning that the cloud is supposed to touch the card it belongs to —
	// and that was wrong twice over. The trail lives inside the cloud's own box and
	// stops short of the card, so a clean placement never needs to reach into it;
	// and excluding it hid a real collision. Measured: where a card straddled the
	// canvas edge, every "above" candidate was off-canvas, the clamp pulled the
	// cloud down onto that card, and the exclusion scored the result as zero while
	// the card's title was 100% hidden underneath.
	for (const cloud of [...input.clouds].reverse()) {
		const blockers = [...obstacles, ...placed];
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
		let chosen = best!;
		if (chosen.overlap > 0) {
			// The grid missed. Try nudging straight out of what is still in the way,
			// within the same sideways bound the grid honours, before reporting that
			// there was nowhere to go — that report is what a product decision would
			// rest on, so it has to mean "searched and there is nothing".
			const slide = cloud.size.width * MAX_SLIDE;
			const centred = cloud.anchor.x - cloud.size.width / 2;
			const nudged = pushOut(chosen.candidate.rect, blockers, input.canvas, {
				left: centred - slide,
				right: centred + slide,
			}, cloud);
			if (nudged) chosen = { candidate: { rect: nudged, side: chosen.candidate.side }, overlap: 0 };
		}
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
