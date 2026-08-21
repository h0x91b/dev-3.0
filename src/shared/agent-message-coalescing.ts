/**
 * The timing of the held Enter that ends a `dev3 message` delivery.
 *
 * Agents write to each other in bursts — three or four messages within a couple of
 * seconds — and each Enter used to start its own agent turn, so the receiver read
 * message 1 while 2, 3 and 4 were still being typed. Holding the submit until the
 * traffic into that pane goes quiet turns the burst into one turn.
 *
 * Shared, because the CLI tells the sender how long its text will sit in the box.
 */

/** Quiet time after the last text before the submit fires. */
export const AGENT_MESSAGE_SUBMIT_IDLE_MS = 10_000;

/**
 * Hard ceiling measured from the first still-unsubmitted text. Without it a steady
 * stream of senders, each arriving inside the idle window, would hold the submit
 * forever and the receiver would never read a word.
 */
export const AGENT_MESSAGE_SUBMIT_CEILING_MS = 30_000;
