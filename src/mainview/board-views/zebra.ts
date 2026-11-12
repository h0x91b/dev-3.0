/** Neutral row stripe for list views: a faint tint of the text colour, so it reads in both themes
 * and never competes with status dots or priority badges. Hover and focus fills override it. */
export const ZEBRA_ROW = "bg-fg/[0.035]";
/** Same stripe for non-virtualized lists, where CSS can pick the even rows itself. */
export const ZEBRA_ROW_EVEN = "even:bg-fg/[0.035]";
/** Accent tint for a coordinator row; replaces the stripe on that row. */
export const COORDINATOR_ROW = "bg-accent/[0.06]";
