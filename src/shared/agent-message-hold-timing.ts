/**
 * The timing of the held `dev3 message` delivery.
 *
 * Agents write to each other in bursts — three or four messages within a couple of
 * seconds — and each Enter used to start its own agent turn, so the receiver read
 * message 1 while 2, 3 and 4 were still being typed. Holding the whole message —
 * its text included, not only its Enter — until the traffic into that pane goes
 * quiet turns the burst into one turn AND keeps a peer's text out of the middle of
 * the line the user is typing (issue #1495).
 *
 * Shared, because the CLI tells the sender how long its message will wait.
 */

/** Quiet time after the last MESSAGE before the held message lands. */
export const AGENT_MESSAGE_HOLD_IDLE_MS = 15_000;

/**
 * Quiet time after the last human KEYSTROKE, which is four times longer.
 *
 * A person composing a prompt stops to think, to read code, to look at a diff — a
 * 15-second pause is an ordinary part of writing one line, not the end of it. Landing
 * a peer's text into that pause is the same defect as landing it mid-word, only later,
 * so his silence has to be much longer before it counts as "he is done".
 */
export const AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS = 60_000;

/**
 * Hard ceiling measured from the first still-undelivered message. Without it a steady
 * stream of senders, each arriving inside the idle window, would hold the message
 * forever and the receiver would never read a word.
 *
 * It bounds a hold pushed back by OTHER MESSAGES only. A hold pushed back by the
 * user's own keystrokes has no ceiling at all: his half-written line outranks any
 * deadline, and the release is then his own Enter or his own silence.
 */
export const AGENT_MESSAGE_HOLD_CEILING_MS = 60_000;

/**
 * Both windows in whole seconds, for prose that quotes them — the CLI's own "queued"
 * line and the skill text every agent reads. Derived rather than restated, because a
 * retune of the constant used to leave four hand-written "ten seconds" behind and
 * agents were then told a number the code no longer honoured.
 */
export const AGENT_MESSAGE_HOLD_IDLE_SECONDS = Math.round(AGENT_MESSAGE_HOLD_IDLE_MS / 1000);
export const AGENT_MESSAGE_HOLD_HUMAN_IDLE_SECONDS = Math.round(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS / 1000);
