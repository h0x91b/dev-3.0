# The notification preview is a bezier cloud over the sender's card

## Context

Notifications became the third arm of the replay timeline
(`decisions/2026/09/10/notification-arm-on-the-replay-timeline.md`) but only
appeared in the inspector list. Standing on a notification, the stage showed
nothing — the reader had to look away from the cards to find out what had just
been said. An earlier attempt at a stage preview was rejected for being far too
large for the card it hangs over.

## Investigation

Six silhouettes were drawn to scale side by side and measured (Seq 1825; the
reference artifact is preserved outside the repo). What the measurement settled:
a union of circles degenerates into a ridged bar exactly where the preview is
smallest, because the lobe radius is capped by the height budget above one line
of text. A cubic-bezier wave has no repeated primitive to read as scalloping and
its amplitude is independent of any corner radius, so it still undulates at a
50px total height. The user picked that variant.

## Decision

`notificationCloud()`
(`src/mainview/components/agent-traffic/notification-cloud.ts`) returns one
closed path plus where the content sits inside it — geometry only, no React and
no colour. `TrafficNotificationCloud` measures its own text and draws the outline
at exact pixel size (a 1:1 viewBox, never a stretched one, or the corner arcs
distort). `TrafficNodes` renders it while the playback cursor stands on a
notification.

Three rulings:

1. **It hangs over the SENDER, never the target.** The archive's `origin` is the
   only card that actually did something. With no sender recorded, the stage
   shows nothing at all rather than borrowing a nearby card — the list already
   says "sender not recorded" in words, and the stage cannot.
2. **The level is a word as well as a colour.** `success` / `info` / `error` is
   the whole point of a preview, and colour alone does not survive a colour-blind
   reader or a screenshot. It reuses the inspector's existing
   `traffic.notification.level.*` keys, so this shipped with no new strings.
3. **A two-puff trail, and no camera motion.** The first cut shipped without the
   trail, on the argument that the anchor over the card already says which card
   sent it. On screen it did not: a cloud floating above a row of cards reads as
   belonging to the row, not to one card. Two ellipses drifting diagonally out of
   the body's card-facing edge fix that, and they cost about 28px of height (15px
   compact) — paid deliberately. Two, not the reference's three: a third adds
   height without adding meaning at these sizes. They drift sideways rather than
   straight down, because a vertical column of puffs reads as a dotted leader
   line instead of the thought-bubble grammar everybody already knows.
   An off-frame sender still gets no preview, and the stage never pans on its own
   to bring one back.

## Risks

The message bubble is not cleared when a notification becomes current, so a
lingering bubble and a fresh cloud can be on screen together — consistent with
the existing "the lit wire stays lit on a non-message step" rule, and they are
told apart by shape and tone. In `happy-dom` the text measures 0, so the
component falls back to its initial box: the geometry is unit-tested separately
and the rendered size is covered only in the browser.

## Alternatives considered

Reusing `TrafficMessageBubble` with a different tone: rejected, a notification is
not an exchange between two cards and a rectangle with a tail says it is.
Anchoring on the target card: rejected, it reads as the target having said
something. Scaling one cloud with `preserveAspectRatio="none"`: rejected, it
distorts the corner arcs at every aspect ratio the text produces.
