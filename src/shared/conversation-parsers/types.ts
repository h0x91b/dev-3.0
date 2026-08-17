/** Options every transcript parser accepts. */
export interface ParseConversationOptions {
	/** Attach the untouched native record to each event. Multiplies the output
	 *  size, so it is off by default and meant for format archaeology. */
	includeRaw?: boolean;
}
